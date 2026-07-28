import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test(".gitmodules points at a repo that still has the pinned commit's history", () => {
  const modules = readFileSync(new URL("../.gitmodules", import.meta.url), "utf8");
  expect(modules).toContain("5uck1ess/audio.cpp-fork");
  // The archived repo is frozen behind the runtime Cicero builds.
  expect(modules).not.toContain("github.com/5uck1ess/audio.cpp\n");
});
