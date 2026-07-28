import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Repointing `.gitmodules` at the maintained fork only helps a FRESH clone.
 * A checkout that initialized the submodule under the old URL keeps that URL in
 * `.git/config`, because `submodule update --init` initializes missing config
 * but never overwrites what is already there. It then tries to fetch the newly
 * pinned commit from a repo that does not contain it and dies before the build.
 *
 * These tests use real git against local repositories — no network — to pin the
 * mechanism, and then tie it to the provisioning script that operators run.
 */

const git = (cwd: string, ...args: string[]): { ok: boolean; out: string } => {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",   // ignore the developer's own git config
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "file",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}` };
};

/** A bare repo with one commit; returns its path and that commit's sha. */
function seedRemote(dir: string, name: string, file: string): { path: string; sha: string } {
  const work = join(dir, `${name}-work`);
  const bare = join(dir, `${name}.git`);
  git(dir, "init", "-q", work);
  writeFileSync(join(work, file), "x\n");
  git(work, "add", "-A");
  git(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `${name} first`);
  git(dir, "clone", "-q", "--bare", work, bare);
  const sha = git(work, "rev-parse", "HEAD").out.trim();
  return { path: bare, sha };
}

test("a submodule initialized under the old URL needs sync to reach the new pin", () => {
  const dir = mkdtempSync(join(tmpdir(), "submodule-url-"));

  // "archived" holds only the original commit; "fork" holds an extra one that
  // exists ONLY there — the situation after repinning at a fork-only commit.
  const archived = seedRemote(dir, "archived", "old.txt");
  const forkWork = join(dir, "fork-work");
  const fork = join(dir, "fork.git");
  git(dir, "clone", "-q", archived.path, forkWork);
  writeFileSync(join(forkWork, "new.txt"), "y\n");
  git(forkWork, "add", "-A");
  git(forkWork, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fork-only commit");
  const forkOnlySha = git(forkWork, "rev-parse", "HEAD").out.trim();
  git(dir, "clone", "-q", "--bare", forkWork, fork);

  // A superproject that added the submodule from the archived URL and
  // initialized it there — i.e. every already-provisioned install.
  const sup = join(dir, "super");
  git(dir, "init", "-q", sup);
  writeFileSync(join(sup, "README"), "super\n");
  git(sup, "add", "-A");
  git(sup, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const added = git(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", archived.path, "vendor/dep");
  expect(added.ok).toBe(true);
  git(sup, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add submodule");
  expect(git(sup, "config", "--get", "submodule.vendor/dep.url").out.trim()).toBe(archived.path);

  // Now the repoint: .gitmodules points at the fork, and the gitlink moves to a
  // commit that only the fork has.
  const modules = join(sup, ".gitmodules");
  writeFileSync(modules, readFileSync(modules, "utf8").replace(archived.path, fork));
  git(join(sup, "vendor/dep"), "fetch", "-q", fork, forkOnlySha);
  git(join(sup, "vendor/dep"), "checkout", "-q", forkOnlySha);
  git(sup, "add", "-A");
  git(sup, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "repoint + repin");

  // Drop the fetched object so the pin genuinely has to come from a remote,
  // reproducing a checkout that never had the fork-only commit locally.
  const fresh = join(dir, "fresh");
  git(dir, "-c", "protocol.file.allow=always", "clone", "-q", sup, fresh);
  const freshSub = join(fresh, "vendor/dep");
  git(fresh, "-c", "protocol.file.allow=always", "submodule", "init");
  // Simulate the pre-existing install: force the stale URL into .git/config.
  git(fresh, "config", "submodule.vendor/dep.url", archived.path);

  // What the provisioner used to do, alone: --init leaves the stale URL, so the
  // fork-only pin cannot be fetched.
  const initOnly = git(fresh, "-c", "protocol.file.allow=always",
    "submodule", "update", "--init", "--recursive", "vendor/dep");
  expect(initOnly.ok).toBe(false);
  // Fail for the RIGHT reason: the stale remote simply does not have the pin.
  expect(initOnly.out).toContain(`did not contain ${forkOnlySha}`);
  expect(git(fresh, "config", "--get", "submodule.vendor/dep.url").out.trim()).toBe(archived.path);

  // With sync first, .git/config follows .gitmodules and the pin resolves.
  const synced = git(fresh, "submodule", "sync", "--recursive", "vendor/dep");
  expect(synced.ok).toBe(true);
  expect(git(fresh, "config", "--get", "submodule.vendor/dep.url").out.trim()).toBe(fork);
  const afterSync = git(fresh, "-c", "protocol.file.allow=always",
    "submodule", "update", "--init", "--recursive", "vendor/dep");
  expect(afterSync.ok).toBe(true);
  expect(git(freshSub, "rev-parse", "HEAD").out.trim()).toBe(forkOnlySha);
});

test("the provisioner syncs the submodule URL before updating, and spares standalone clones", () => {
  const script = readFileSync(new URL("../scripts/provision-audiocpp.sh", import.meta.url), "utf8");
  const sync = script.indexOf("submodule sync");
  const update = script.indexOf("submodule update --init");
  expect(sync).toBeGreaterThan(-1);
  expect(sync).toBeLessThan(update);
  // The dev/fork-sync layout is a standalone clone whose `origin` tracks
  // upstream; syncing it would clobber that remote.
  expect(script).toContain('if [[ -d "$SUB/.git" ]]');
});

test("the provisioner rebuilds when the pin moves, instead of trusting a stale binary", () => {
  // `/build*/` is git-ignored, so checking out a new pin leaves the previously
  // built executable in place. Skipping on mere presence would keep running the
  // old revision — past the very fixes the new pin was chosen for. Drives the
  // REAL script against a stub build_linux.sh, so no compiler is needed.
  const dir = mkdtempSync(join(tmpdir(), "provision-stale-"));
  const buildLog = join(dir, "build-invocations");
  const commit = (cwd: string, msg: string) =>
    git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);

  // A "vendor" repo whose build script just fabricates the binary.
  const depWork = join(dir, "dep-work");
  git(dir, "init", "-q", depWork);
  mkdirSync(join(depWork, "scripts"), { recursive: true });
  writeFileSync(join(depWork, "scripts/build_linux.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'echo "build $*" >> "${BUILD_LOG:?}"',
    "mkdir -p build/linux-cuda-release/bin",
    "printf '#!/bin/sh\\nexit 0\\n' > build/linux-cuda-release/bin/audiocpp_server",
    "chmod +x build/linux-cuda-release/bin/audiocpp_server",
  ].join("\n"));
  git(depWork, "add", "-A");
  commit(depWork, "vendor at A");
  const shaA = git(depWork, "rev-parse", "HEAD").out.trim();
  const depBare = join(dir, "dep.git");
  git(dir, "clone", "-q", "--bare", depWork, depBare);

  // A superproject holding the real provisioner and that repo as a submodule.
  const root = join(dir, "root");
  git(dir, "init", "-q", root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  const realScript = readFileSync(new URL("../scripts/provision-audiocpp.sh", import.meta.url), "utf8");
  writeFileSync(join(root, "scripts/provision-audiocpp.sh"), realScript, { mode: 0o755 });
  git(root, "add", "-A");
  commit(root, "root init");
  expect(git(root, "-c", "protocol.file.allow=always",
    "submodule", "add", "-q", depBare, "vendor/audio.cpp").ok).toBe(true);
  commit(root, "add submodule at A");

  const provision = (): { ok: boolean; out: string } => {
    const r = Bun.spawnSync(["bash", join(root, "scripts/provision-audiocpp.sh")], {
      cwd: dir,   // deliberately NOT inside root: the script resolves its own ROOT
      env: {
        ...process.env,
        BUILD_LOG: buildLog,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        // Let the script's own git calls touch the file:// submodule remote.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "protocol.file.allow",
        GIT_CONFIG_VALUE_0: "always",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return { ok: r.exitCode === 0, out: `${r.stdout.toString()}${r.stderr.toString()}` };
  };
  const builds = (): number =>
    (readFileSync(buildLog, "utf8").match(/^build /gm) ?? []).length;
  const stamp = join(root, "vendor/audio.cpp/build/linux-cuda-release/.built-from-commit");

  // 1. First provision builds and records what it built from.
  const first = provision();
  expect(first.ok).toBe(true);
  expect(builds()).toBe(1);
  expect(readFileSync(stamp, "utf8").trim()).toBe(shaA);

  // 2. Unchanged pin: skip, no rebuild.
  const second = provision();
  expect(second.ok).toBe(true);
  expect(second.out).toContain(`Already built at ${shaA}`);
  expect(builds()).toBe(1);

  // 3. Move the pin — the exact shape of repointing at a fixed upstream commit.
  writeFileSync(join(depWork, "FIX"), "oom hardening\n");
  git(depWork, "add", "-A");
  commit(depWork, "vendor at B (the fix the new pin is chosen for)");
  const shaB = git(depWork, "rev-parse", "HEAD").out.trim();
  git(depWork, "push", "-q", depBare, "HEAD");
  const sub = join(root, "vendor/audio.cpp");
  git(sub, "fetch", "-q", depBare, shaB);
  git(sub, "checkout", "-q", shaB);
  git(root, "add", "vendor/audio.cpp");
  commit(root, "repin to B");
  // The stale binary really does survive the repin — that is the premise.
  expect(existsSync(join(sub, "build/linux-cuda-release/bin/audiocpp_server"))).toBe(true);

  const third = provision();
  expect(third.ok).toBe(true);
  expect(third.out).toContain(`was built from ${shaA}`);
  expect(builds()).toBe(2);
  expect(readFileSync(stamp, "utf8").trim()).toBe(shaB);
});

const BUILD_STUB = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'echo "build $*" >> "${BUILD_LOG:?}"',
  "mkdir -p build/linux-cuda-release/bin",
  "printf '#!/bin/sh\\nexit 0\\n' > build/linux-cuda-release/bin/audiocpp_server",
  "chmod +x build/linux-cuda-release/bin/audiocpp_server",
].join("\n");

test("a standalone clone reaches a fork-only pin without losing its upstream remote", () => {
  // The dev/fork-sync layout: vendor/audio.cpp is a standalone clone whose
  // `origin` tracks UPSTREAM. Skipping `submodule sync` protects that remote,
  // but `submodule update` then fetches from `origin` — which does not carry a
  // fork-only pin — so provisioning died before the build. The pin has to be
  // fetched by URL instead: no remote created, none rewritten.
  const dir = mkdtempSync(join(tmpdir(), "provision-standalone-"));
  const buildLog = join(dir, "build-invocations");
  const commit = (cwd: string, msg: string) =>
    git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);

  // upstream has A; the fork has A + B, and B exists ONLY in the fork.
  const upWork = join(dir, "up-work");
  git(dir, "init", "-q", upWork);
  mkdirSync(join(upWork, "scripts"), { recursive: true });
  writeFileSync(join(upWork, "scripts/build_linux.sh"), BUILD_STUB);
  git(upWork, "add", "-A");
  commit(upWork, "upstream A");
  const shaA = git(upWork, "rev-parse", "HEAD").out.trim();
  const upBare = join(dir, "up.git");
  git(dir, "clone", "-q", "--bare", upWork, upBare);

  const forkWork = join(dir, "fork-work");
  git(dir, "clone", "-q", upBare, forkWork);
  writeFileSync(join(forkWork, "PCM"), "live pcm ingest\n");
  git(forkWork, "add", "-A");
  commit(forkWork, "fork-only B");
  const shaB = git(forkWork, "rev-parse", "HEAD").out.trim();
  git(forkWork, "branch", "-M", "cicero-integration");
  const forkBare = join(dir, "fork.git");
  git(dir, "clone", "-q", "--bare", forkWork, forkBare);

  // Superproject: the real provisioner, .gitmodules naming the fork, gitlink at B.
  const root = join(dir, "root");
  git(dir, "init", "-q", root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts/provision-audiocpp.sh"),
    readFileSync(new URL("../scripts/provision-audiocpp.sh", import.meta.url), "utf8"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, ".gitmodules"),
    `[submodule "vendor/audio.cpp"]\n\tpath = vendor/audio.cpp\n\turl = ${forkBare}\n\tbranch = cicero-integration\n`,
  );
  git(root, "add", "-A");
  commit(root, "root with provisioner");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${shaB},vendor/audio.cpp`);
  commit(root, "pin to the fork-only commit");

  // vendor/audio.cpp as a STANDALONE clone of upstream, detached at A, no B.
  mkdirSync(join(root, "vendor"), { recursive: true });
  git(root, "clone", "-q", upBare, join(root, "vendor/audio.cpp"));
  const sub = join(root, "vendor/audio.cpp");
  git(sub, "checkout", "-q", "--detach", shaA);
  expect(git(sub, "cat-file", "-e", `${shaB}^{commit}`).ok).toBe(false); // genuinely absent

  const r = Bun.spawnSync(["bash", join(root, "scripts/provision-audiocpp.sh")], {
    cwd: dir,
    env: {
      ...process.env,
      BUILD_LOG: buildLog,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`;
  expect({ ok: r.exitCode === 0, out }).toMatchObject({ ok: true });
  // The pin is now reachable and checked out...
  expect(git(sub, "rev-parse", "HEAD").out.trim()).toBe(shaB);
  // ...and the upstream-tracking remote the sync pipeline reads is untouched.
  expect(git(sub, "remote", "get-url", "origin").out.trim()).toBe(upBare);
  expect((readFileSync(buildLog, "utf8").match(/^build /gm) ?? []).length).toBe(1);
});

test("a binary with no recorded provenance is rebuilt rather than trusted", () => {
  // Every install predating the stamp is in this state; assuming it is current
  // would silently keep the pre-fix binary running.
  const script = readFileSync(new URL("../scripts/provision-audiocpp.sh", import.meta.url), "utf8");
  expect(script).toContain("records no source commit");
  // The stamp is written only after the binary is confirmed present, so a
  // failed build cannot make the next run skip.
  const stampWrite = script.indexOf('> "$STAMP"');
  const binCheck = script.lastIndexOf('if [[ -x "$BIN" ]]');
  expect(binCheck).toBeGreaterThan(-1);
  expect(stampWrite).toBeGreaterThan(binCheck);
});

test(".gitmodules points at a repo that still has the pinned commit's history", () => {
  const modules = readFileSync(new URL("../.gitmodules", import.meta.url), "utf8");
  expect(modules).toContain("5uck1ess/audio.cpp-fork");
  // The archived repo is frozen behind the runtime Cicero builds.
  expect(modules).not.toContain("github.com/5uck1ess/audio.cpp\n");
});
