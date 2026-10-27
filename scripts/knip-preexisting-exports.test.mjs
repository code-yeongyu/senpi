#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOptions } from "knip/session";
import preprocess from "./knip-preexisting-exports.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// scripts/knip-preexisting-exports.ts is shared byte for byte with sisyphuslabs/omo-relay-daemon (merged in daemon#123,
// ceadfe2914; copied from daemon main 757e46e0b6) and omo-service. Update every copy together; a change here alone
// means the copies drifted (senpi#4421).
const SHARED_PREPROCESSOR_SHA256 = "a92ddf4eaa74dcb54aacc5a3eb975d6c5f7ffec3897cd9ee31857bbd0ca19d22";

test("the knip preprocessor is byte-identical to omo-relay-daemon's copy", () => {
	const bytes = readFileSync(new URL("./knip-preexisting-exports.ts", import.meta.url));
	assert.equal(createHash("sha256").update(bytes).digest("hex"), SHARED_PREPROCESSOR_SHA256);
});

test("the preprocessor drops only the listed (file, export) pairs", () => {
	const issue = { type: "exports", workspace: ".", fixes: [] };
	const result = preprocess({
		cwd: "/repo",
		preprocessorOptions: JSON.stringify({ preExistingExports: { "src/a.ts": ["kept", "gone"] } }),
		counters: { exports: 3 },
		issues: {
			exports: {
				"/repo/src/a.ts": {
					"pkg.gone": { ...issue, filePath: "/repo/src/a.ts", symbol: "gone" },
					fresh: { ...issue, filePath: "/repo/src/a.ts", symbol: "fresh" },
				},
				"/repo/src/b.ts": { gone: { ...issue, filePath: "/repo/src/b.ts", symbol: "gone" } },
			},
		},
	});
	assert.deepEqual(
		Object.fromEntries(Object.entries(result.issues.exports).map(([file, symbols]) => [file, Object.keys(symbols)])),
		{ "/repo/src/a.ts": ["fresh"], "/repo/src/b.ts": ["gone"] },
	);
	assert.equal(result.counters.exports, 2);
});

// Every listed (file, export) pair must still be an unused export knip reports, so the list cannot go stale: a fixed
// or removed export has to leave knip.jsonc in the same change.
test("every preExistingExports entry in knip.jsonc is still reported by knip", async () => {
	const listed = JSON.parse((await createOptions({ cwd: repo, args: {} })).preprocessorOptions).preExistingExports;
	const knip = spawnSync(
		process.execPath,
		[resolve(repo, "node_modules/knip/bin/knip.js"), "--reporter", "json", "--no-progress", "--preprocessor-options", JSON.stringify({ preExistingExports: {} })],
		{ cwd: repo, encoding: "utf8", maxBuffer: 256 << 20 },
	);
	assert.notEqual(knip.stdout.trim(), "", `knip printed no report (status ${knip.status}): ${knip.stderr}`);
	const reported = new Set(JSON.parse(knip.stdout).issues.flatMap((issue) => issue.exports.map((e) => `${issue.file}#${e.name}`)));
	const pairs = Object.entries(listed).flatMap(([file, names]) => names.map((name) => `${file}#${name}`));
	assert.ok(pairs.length > 0, "knip.jsonc lists no preExistingExports");
	console.log(`knip-preexisting-exports: ${pairs.length} listed exports in ${Object.keys(listed).length} files`);
	assert.deepEqual(pairs.filter((pair) => !reported.has(pair)), [], "listed exports knip no longer reports; remove them from preprocessorOptions.preExistingExports");
});
