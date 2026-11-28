#!/usr/bin/env node
// senpi#4783: an older Bun has no `bun check` and resolves it to this package's `check` script,
// which re-enters itself forever. The root check script must reach the type checker through the
// version-gated wrapper, as `fmt` already does through scripts/bun-fmt.mjs (senpi#5572).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { supportsCheck } from "./bun-check.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("root check script type-check gate", () => {
	it("never invokes bare `bun check`, only the version-gated wrapper", () => {
		const script = packageJson.scripts.check;
		assert.doesNotMatch(script, /(^|&&\s*)bun check\b/, `bare bun check recurses on an older Bun: ${script}`);
		assert.match(script, /node scripts\/bun-check\.mjs --all -p tsconfig\.json\b/);
		assert.match(script, /node scripts\/bun-check\.mjs --all -p scripts\/tsconfig\.json\b/);
	});

	it("refuses a Bun without the check command", () => {
		assert.equal(supportsCheck("1.4.4"), true);
		assert.equal(supportsCheck("1.5.0\n"), true);
		assert.equal(supportsCheck("1.4.3"), false);
		assert.equal(supportsCheck("not-a-version"), false);
	});
});
