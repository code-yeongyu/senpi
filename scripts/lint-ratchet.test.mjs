#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, it } from "node:test";
import { fileURLToPath } from "node:url";

import { compare, countByFile, countSuppressions, lint, SUPPRESSION } from "./lint-ratchet.mjs";

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

it("counts every disable comment that could hide one of the ratcheted rules, in both linters' forms", () => {
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

it("counts a disable comment that names one of the senpi-testing rules", () => {
  // Built at runtime so this file holds no directive of its own for the gate to count.
  const line = "/".repeat(2);
  const source = [
    `${line} oxlint-disable-next-line senpi-testing/no-fixed-sleep`,
    `${line} eslint-disable-next-line senpi-testing/no-flake-masking -- unrelated rule, not counted`,
    `${line} oxlint-disable-next-line eslint/no-console`,
  ].join("\n");
  assert.equal(countSuppressions("probe.ts", source), 2);
});

// The ratchet's own lint run in a scratch git repo that reuses this repo's oxlint and plugin, with a
// violating test beside a copy of the ratchet config (a config's ignorePatterns resolve in its own
// directory). Listed in .eslintignore, the test is still counted; hidden by the config's
// ignorePatterns, which --no-ignore does not reach, it is reported as skipped instead of as zero.
let listedInEslintignore;
let hiddenByIgnorePatterns;
before(
  () => {
    const repo = fileURLToPath(new URL("../", import.meta.url));
    const scratch = mkdtempSync(join(tmpdir(), "senpi-lint-ratchet-ignore-"));
    try {
      const config = join(scratch, "scripts/lint-ratchet.oxlintrc.json");
      const shipped = JSON.parse(readFileSync(join(repo, "scripts/lint-ratchet.oxlintrc.json"), "utf8"));
      mkdirSync(dirname(config), { recursive: true });
      for (const entry of ["node_modules", "scripts/oxlint"]) symlinkSync(join(repo, entry), join(scratch, entry), "dir");
      writeFileSync(config, JSON.stringify(shipped));
      writeFileSync(
        join(scratch, "scripts/hidden.test.ts"),
        'import { mock } from "bun:test";\nmock.module("./dep", () => ({}));\n',
      );
      writeFileSync(join(scratch, "clean.ts"), "export const clean = 1;\n");
      writeFileSync(join(scratch, ".eslintignore"), "scripts/hidden.test.ts\n");
      for (const args of [["init", "-q"], ["add", "--", "."]])
        assert.equal(spawnSync("git", args, { cwd: scratch }).status, 0);
      listedInEslintignore = lint(scratch);
      writeFileSync(config, JSON.stringify({ ...shipped, ignorePatterns: ["hidden.test.ts"] }));
      hiddenByIgnorePatterns = lint(scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  { timeout: 60_000 },
);

it("still counts a violating file that .eslintignore lists", () => {
  assert.deepEqual(listedInEslintignore, {
    counts: { "scripts/hidden.test.ts": { "senpi-testing/no-module-mock": 1 } },
    unparsed: [],
    skipped: 0,
  });
});

it("reports a file hidden by the ratchet config's ignorePatterns as skipped, not as zero findings", () => {
  assert.deepEqual(hiddenByIgnorePatterns, { counts: {}, unparsed: [], skipped: 1 });
});
