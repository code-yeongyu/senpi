#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const code = "senpi-copy(no-em-dash-copy)";
const message = "No em dashes in product copy. Use a period, comma, colon, or parentheses instead.";

// Exercise the shipped config, not a test-only visitor: losing its source scope must fail too (#4040).
// The fixture tree is a copy of the config beside the real plugins under the OS temp root: a directory
// inside packages/*/src would race every scripts test that scans the source tree (#4145).
const fixtureRoot = () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-copy-rule-")));
	copyFileSync(join(root, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
	symlinkSync(join(root, "scripts"), join(dir, "scripts"), "dir");
	return dir;
};

const lint = (filename, source) => {
	const dir = fixtureRoot();
	try {
		const file = join(dir, "packages", "coding-agent", "src", filename);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, source);
		const result = spawnSync(
			process.execPath,
			[join(root, "node_modules", "oxlint", "bin", "oxlint"), "-c", ".oxlintrc.json", "-f", "json", file],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.ok(result.status === 0 || result.status === 1, result.stderr);
		return JSON.parse(result.stdout).diagnostics;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("the copy-rule fixture tree", () => {
	it("lives outside the repository, so no source scan can meet it", () => {
		const dir = fixtureRoot();
		try {
			assert.ok(relative(realpathSync(root), dir).startsWith(".."), dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("no-em-dash-copy through the product lint configuration", () => {
	for (const [name, source] of [
		["string literal", 'export const label = "Refresh failed — retry";'],
		["escaped string literal", 'export const label = "Refresh failed \\u2014 retry";'],
		["template element", `export const label = \`\${name} — \${kind}\`;`],
		["JSX text", "export const label = <p>Run a prompt — on an interval</p>;"],
	]) {
		it(`reports a ${name}`, () => {
			const findings = lint("copy.tsx", source).filter((d) => d.code === code);
			assert.equal(findings.length, 1);
			assert.equal(findings[0].message, message);
		});
	}

	it("allows comments, regex literals, hyphens, and en dashes", () => {
		const findings = lint(
			"copy.tsx",
			`
			// Parses titles like "Issue — Browser".
			export const title = /^ [–—-] \\S/u;
			export const label = "Refresh failed - retry 1–2";
		`,
		);
		assert.deepEqual(
			findings.filter((d) => d.code === code),
			[],
		);
	});

	for (const extension of ["mjs", "cjs", "mts", "cts"]) {
		it(`checks product .${extension} files`, () => {
			const source =
				extension === "cjs"
					? 'module.exports = "Refresh failed — retry";'
					: 'export const label = "Refresh failed — retry";';
			const findings = lint(`copy.${extension}`, source).filter((d) => d.code === code);
			assert.equal(findings.length, 1);
		});
	}

	for (const filename of [
		"copy.test.ts",
		"copy.spec.tsx",
		"test/copy.ts",
		"tests/copy.ts",
		"testkit/copy.ts",
		"fixtures/copy.ts",
		"testUtils/copy.ts",
		"_generated/copy.ts",
		"copy.gen.ts",
		"copy.generated.ts",
		"vendor/copy.ts",
	]) {
		it(`exempts ${filename}`, () => {
			assert.deepEqual(
				lint(filename, 'export const label = "verbatim — fixture";').filter((d) => d.code === code),
				[],
			);
		});
	}
});

describe("require-suppression-reason through the lint configuration", () => {
	const ruleCode = "senpi-copy(require-suppression-reason)";
	for (const [name, source] of [
		[
			"lint reason",
			"// oxlint-disable-next-line no-console -- This script reports to the terminal.\nconsole.log(1);",
		],
		["eslint reason", "/* eslint-disable no-console -- This script reports to the terminal. */"],
		[
			"comment above",
			"// Stable positions in this fixed list.\n// oxlint-disable-next-line no-unused-vars\nconst x = 1;",
		],
		[
			"stacked directives",
			"// Invalid fixture on purpose.\n// @ts-expect-error\n// oxlint-disable-next-line no-unused-vars\nconst x: number = 'text';",
		],
		[
			"TypeScript reason",
			"// @ts-expect-error -- The fixture passes a string on purpose.\nconst x: number = 'text';",
		],
		["TypeScript inline prose", "// @ts-ignore The fixture passes a string on purpose.\nconst x: number = 'text';"],
		["nocheck reason", "// @ts-nocheck -- This fixture models untyped callers."],
		["JSX reason", "const node = <div>{/* oxlint-disable-next-line no-danger -- Sanitized above. */}</div>;"],
		["enable", "/* oxlint-enable no-console */"],
		["empty comment between", "// Fixed positions.\n//\n// oxlint-disable-next-line no-unused-vars\nconst x = 1;"],
	]) {
		it(`allows ${name}`, () => {
			assert.deepEqual(
				lint("suppression.tsx", source).filter((d) => d.code === ruleCode),
				[],
			);
		});
	}
	for (const [name, source] of [
		["lint directive", "// oxlint-disable-next-line no-unused-vars\nconst x = 1;"],
		["file directive", "/* eslint-disable no-console */"],
		["TypeScript directive", "// @ts-expect-error\nconst x: number = 'text';"],
		["ignore directive", "// @ts-ignore\nconst x: number = 'text';"],
		["nocheck directive", "// @ts-nocheck\nconst x: number = 'text';"],
		["blank line after reason", "// Fixed positions.\n\n// oxlint-disable-next-line no-unused-vars\nconst x = 1;"],
		["empty comments only", "//\n/* */\n// oxlint-disable-next-line no-unused-vars\nconst x = 1;"],
		[
			"trailing comment above",
			"const first = 1; // A value.\nconst second = 2; // oxlint-disable-line no-unused-vars",
		],
	]) {
		it(`reports unexplained ${name}`, () => {
			const findings = lint("suppression.tsx", source).filter((d) => d.code === ruleCode);
			assert.equal(findings.length, 1);
		});
	}
});
