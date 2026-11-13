#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { compare, countByFile, countSuppressions, SUPPRESSION } from "./lint-ratchet.mjs";

const root = "/repo";

it("counts findings per file and rule, relative to the repo root", () => {
  const counts = countByFile(
    [
      { code: "typescript(no-non-null-assertion)", filename: "packages/coding-agent/src/a.ts" },
      { code: "typescript(no-non-null-assertion)", filename: "/repo/packages/coding-agent/src/a.ts" },
      { code: "typescript(no-explicit-any)", filename: "packages/coding-agent/src/a.ts" },
      { code: "typescript(ban-ts-comment)", filename: "scripts/b.ts" },
    ],
    root,
  );
  assert.deepEqual(counts, {
    "packages/coding-agent/src/a.ts": { "typescript/no-non-null-assertion": 2, "typescript/no-explicit-any": 1 },
    "scripts/b.ts": { "typescript/ban-ts-comment": 1 },
  });
});

it("refuses a count that goes up, including any finding in a file the baseline does not list", () => {
  const { increases } = compare(
    { "packages/coding-agent/src/a.ts": { "typescript/no-non-null-assertion": 2 } },
    {
      "packages/coding-agent/src/a.ts": { "typescript/no-non-null-assertion": 3 },
      "packages/coding-agent/src/new.ts": { "typescript/no-explicit-any": 1 },
    },
  );
  assert.deepEqual(increases, [
    { file: "packages/coding-agent/src/a.ts", rule: "typescript/no-non-null-assertion", before: 2, after: 3 },
    { file: "packages/coding-agent/src/new.ts", rule: "typescript/no-explicit-any", before: 0, after: 1 },
  ]);
});

it("reports a count that goes down, so the baseline must be lowered in the same change", () => {
  const { increases, decreases } = compare(
    {
      "packages/coding-agent/src/a.ts": { "typescript/no-non-null-assertion": 2 },
      "packages/coding-agent/src/gone.ts": { "typescript/no-explicit-any": 1 },
    },
    { "packages/coding-agent/src/a.ts": { "typescript/no-non-null-assertion": 2 } },
  );
  assert.deepEqual(increases, []);
  assert.deepEqual(decreases, [
    { file: "packages/coding-agent/src/gone.ts", rule: "typescript/no-explicit-any", before: 1, after: 0 },
  ]);
});

it("accepts counts that match the baseline exactly", () => {
  const counts = { "packages/coding-agent/src/a.ts": { "typescript/no-non-null-assertion": 2 } };
  assert.deepEqual(compare(counts, counts), { increases: [], decreases: [] });
});

it("counts every disable comment that could hide one of the three rules, in both linters' forms", () => {
  // Built at runtime so this file holds no directive of its own for the gate to count.
  const line = "/".repeat(2);
  const block = ["/", "*"].join("");
  const source = [
    `${line} oxlint-disable-next-line typescript/no-explicit-any`,
    `${line} eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy`,
    `${block} eslint-disable */`,
    `const a = 1; ${line} oxlint-disable-line`,
    `${line} oxlint-disable-next-line typescript/ban-ts-comment, eslint/no-console`,
    `${line} oxlint-disable-next-line eslint/no-console -- unrelated rule, not counted`,
    `const text = "oxlint-disable-next-line typescript/no-explicit-any";`,
    `${block}\n  eslint-disable-next-line typescript/no-explicit-any\n*/`,
  ].join("\n");
  assert.equal(countSuppressions("probe.ts", source), 6);
  assert.equal(countSuppressions("probe.ts", "const x = 1;\n"), 0);
});

it("refuses a new disable comment like any other rise", () => {
  const { increases } = compare({}, { "scripts/probe.ts": { [SUPPRESSION]: 1 } });
  assert.deepEqual(increases, [{ file: "scripts/probe.ts", rule: SUPPRESSION, before: 0, after: 1 }]);
});

const cliFixture = (t, files) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "senpi-lint-ratchet-")));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }));
  mkdirSync(join(repo, "scripts"));
  for (const name of ["lint-ratchet.mjs", "lint-ratchet.oxlintrc.json"])
    copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(repo, "scripts", name));
  symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(repo, "node_modules"), "junction");
  const sourceDir = "sources with spaces é🦊";
  mkdirSync(join(repo, sourceDir));
  const baseline = {};
  for (const name of files) {
    const file = `${sourceDir}/${name}.ts`;
    writeFileSync(join(repo, file), "export type Value = any;\n");
    baseline[file] = { "typescript/no-explicit-any": 1 };
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "--", sourceDir], { cwd: repo });
  return { repo, baseline, baselinePath: join(repo, "scripts/lint-ratchet.baseline.json") };
};

const runCli = (repo, preload) => spawnSync(process.execPath, [
  "--require", preload, join(repo, "scripts/lint-ratchet.mjs"), "--update", "--allow-increase",
], { cwd: repo, encoding: "utf8", timeout: 30_000 });

it("lints every tracked file exactly once when the corpus exceeds the Windows command limit", (t) => {
  const files = Array.from({ length: 500 }, (_, index) => `${"long-file-name-".repeat(6)}${index}`);
  const { repo, baseline, baselinePath } = cliFixture(t, files);
  const preload = join(repo, "command-limit.cjs");
  // The real CLI and linter run on every OS. This lower bound also reproduces the Windows
  // failure on Unix, without duplicating the production quoting/size estimator.
  writeFileSync(preload, `
    const childProcess = require("node:child_process");
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      if (command.endsWith("oxlint") && [command, ...args].join(" ").length + 1 > 32767) {
        return { status: null, stdout: null, stderr: null,
          error: Object.assign(new Error("Windows command line exceeds 32767 characters"), { code: "ENAMETOOLONG" }) };
      }
      return spawnSync(command, args, options);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  assert.ok(Object.keys(baseline).join(" ").length > 32767);
  const result = runCli(repo, preload);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), baseline);
});

it("reports the spawn error and leaves the baseline unchanged when oxlint cannot start", (t) => {
  const { repo, baseline, baselinePath } = cliFixture(t, ["one"]);
  const before = JSON.stringify(baseline);
  writeFileSync(baselinePath, before);
  const preload = join(repo, "spawn-failure.cjs");
  writeFileSync(preload, `
    const childProcess = require("node:child_process");
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => command.endsWith("oxlint")
      ? { status: null, stdout: null, stderr: null,
          error: Object.assign(new Error("fixture spawn failure"), { code: "E2BIG" }) }
      : spawnSync(command, args, options);
    require("node:module").syncBuiltinESMExports();
  `);
  const result = runCli(repo, preload);
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /E2BIG.*fixture spawn failure/);
  assert.doesNotMatch(result.stdout, /baseline written|every count matches/);
  assert.equal(readFileSync(baselinePath, "utf8"), before);
});
