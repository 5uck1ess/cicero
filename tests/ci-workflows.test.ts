import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = join(import.meta.dir, "..");
const workflowDirectory = join(root, ".github", "workflows");

interface WorkflowUse {
  filename: string;
  jobName: string;
  location: string;
  reference: string;
  owner: Record<string, unknown>;
  job: Record<string, unknown>;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${context} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  owner: Record<string, unknown>,
  field: string,
  context: string,
): string | undefined {
  const value = owner[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${context}.${field} must be a string`);
  return value;
}

function workflowFiles(): string[] {
  return readdirSync(workflowDirectory)
    .filter((filename) => filename.endsWith(".yml") || filename.endsWith(".yaml"))
    .sort();
}

function parseMapping(source: string, context: string): Record<string, unknown> {
  const parsed: unknown = parse(source);
  return record(parsed, context);
}

function collectWorkflowUses(source: string, filename: string): WorkflowUse[] {
  const workflow = parseMapping(source, filename);
  const jobs = record(workflow.jobs, `${filename}.jobs`);
  const uses: WorkflowUse[] = [];

  for (const [jobName, rawJob] of Object.entries(jobs)) {
    const job = record(rawJob, `${filename}.jobs.${jobName}`);
    const reusable = stringField(job, "uses", `${filename}.jobs.${jobName}`);
    if (reusable) {
      uses.push({
        filename,
        jobName,
        location: `jobs.${jobName}.uses`,
        reference: reusable,
        owner: job,
        job,
      });
    }

    const rawSteps = job.steps;
    if (rawSteps === undefined) continue;
    if (!Array.isArray(rawSteps)) {
      throw new TypeError(`${filename}.jobs.${jobName}.steps must be a sequence`);
    }
    for (let index = 0; index < rawSteps.length; index++) {
      const step = record(rawSteps[index], `${filename}.jobs.${jobName}.steps[${index}]`);
      const reference = stringField(
        step,
        "uses",
        `${filename}.jobs.${jobName}.steps[${index}]`,
      );
      if (!reference) continue;
      uses.push({
        filename,
        jobName,
        location: `jobs.${jobName}.steps[${index}].uses`,
        reference,
        owner: step,
        job,
      });
    }
  }

  return uses;
}

function repository(reference: string): string {
  const separator = reference.lastIndexOf("@");
  return separator === -1 ? reference : reference.slice(0, separator);
}

function allWorkflowUses(): WorkflowUse[] {
  return workflowFiles().flatMap((filename) => collectWorkflowUses(
    readFileSync(join(workflowDirectory, filename), "utf8"),
    filename,
  ));
}

function packageVersions(): { bun: string; bunTypes: string } {
  const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packageJson = record(parsed, "package.json");
  const packageManager = stringField(packageJson, "packageManager", "package.json");
  const bun = packageManager?.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1];
  if (!bun) throw new TypeError("package.json.packageManager must pin an exact Bun release");
  const devDependencies = record(packageJson.devDependencies, "package.json.devDependencies");
  const bunTypes = stringField(devDependencies, "@types/bun", "package.json.devDependencies");
  if (!bunTypes) throw new TypeError("package.json must pin @types/bun");
  return { bun, bunTypes };
}

test("workflow traversal includes named steps and reusable workflow jobs", () => {
  const uses = collectWorkflowUses(`
jobs:
  named-step:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
  reusable:
    uses: owner/repository/.github/workflows/reusable.yml@main
`, "synthetic.yml");

  expect(uses.map(({ location, reference }) => ({ location, reference }))).toEqual([
    {
      location: "jobs.named-step.steps[0].uses",
      reference: "actions/checkout@v4",
    },
    {
      location: "jobs.reusable.uses",
      reference: "owner/repository/.github/workflows/reusable.yml@main",
    },
  ]);
});

test("third-party actions and reusable workflows use immutable commit SHAs", () => {
  const uses = allWorkflowUses();
  expect(uses.length).toBeGreaterThan(0);

  for (const use of uses) {
    if (use.reference.startsWith("./")) continue;
    expect(use.reference, `${use.filename}: ${use.location}`).toMatch(
      /^[^@\s]+@[a-f0-9]{40}$/,
    );
  }
});

test("every setup-bun use matches packageManager and the Bun type lock", () => {
  const { bun, bunTypes } = packageVersions();
  expect(bunTypes).toBe(bun);

  const setupBunUses = allWorkflowUses()
    .filter((use) => repository(use.reference) === "oven-sh/setup-bun");
  expect(setupBunUses.length).toBeGreaterThan(0);
  for (const use of setupBunUses) {
    const withOptions = record(use.owner.with, `${use.filename}: ${use.location}.with`);
    expect(withOptions["bun-version"], `${use.filename}: ${use.location}`).toBe(bun);
  }

  const lock = parseMapping(readFileSync(join(root, "bun.lock"), "utf8"), "bun.lock");
  const workspaces = record(lock.workspaces, "bun.lock.workspaces");
  const workspace = record(workspaces[""], 'bun.lock.workspaces[""]');
  const lockedDevDependencies = record(
    workspace.devDependencies,
    'bun.lock.workspaces[""].devDependencies',
  );
  expect(lockedDevDependencies["@types/bun"]).toBe(bun);

  const packages = record(lock.packages, "bun.lock.packages");
  const lockedTypes = packages["@types/bun"];
  const lockedRuntimeTypes = packages["bun-types"];
  expect(Array.isArray(lockedTypes) ? lockedTypes[0] : undefined).toBe(`@types/bun@${bun}`);
  expect(Array.isArray(lockedRuntimeTypes) ? lockedRuntimeTypes[0] : undefined)
    .toBe(`bun-types@${bun}`);
  const lockedTypesMetadata = Array.isArray(lockedTypes)
    ? record(lockedTypes[2], 'bun.lock.packages["@types/bun"][2]')
    : {};
  const lockedTypesDependencies = record(
    lockedTypesMetadata.dependencies,
    'bun.lock.packages["@types/bun"][2].dependencies',
  );
  expect(lockedTypesDependencies["bun-types"]).toBe(bun);
});

test("every setup-uv use pins one version and owns a collision-free cache suffix", () => {
  const setupUvUses = allWorkflowUses()
    .filter((use) => repository(use.reference) === "astral-sh/setup-uv");
  expect(setupUvUses.length).toBeGreaterThan(0);

  const versions: string[] = [];
  const suffixes: string[] = [];
  for (const use of setupUvUses) {
    const context = `${use.filename}: ${use.location}`;
    const withOptions = record(use.owner.with, `${context}.with`);
    const version = stringField(withOptions, "version", `${context}.with`);
    expect(version, context).toMatch(/^\d+\.\d+\.\d+$/);
    versions.push(version!);

    if (withOptions["enable-cache"] !== true && withOptions["enable-cache"] !== "true") continue;
    const suffix = stringField(withOptions, "cache-suffix", `${context}.with`);
    expect(suffix?.trim(), `${context} needs a non-empty cache-suffix`).toBeTruthy();
    suffixes.push(suffix!);

    const strategy = use.job.strategy;
    if (strategy === undefined) continue;
    const matrix = record(record(strategy, `${context}.strategy`).matrix, `${context}.matrix`);
    const resolutions = matrix.resolution;
    if (Array.isArray(resolutions) && resolutions.length > 1) {
      expect(suffix, `${context} must separate resolution-matrix caches`)
        .toContain("${{ matrix.resolution }}");
    }
  }

  expect(new Set(versions).size, "setup-uv versions must agree").toBe(1);
  expect(new Set(suffixes).size, "setup-uv cache suffixes must be unique by use-case")
    .toBe(suffixes.length);
});
