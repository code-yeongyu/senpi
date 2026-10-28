#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createOptions } from "knip/session";
import preprocess from "./knip-preexisting-exports.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// scripts/knip-preexisting-exports.ts is shared byte for byte with sisyphuslabs/omo-relay-daemon (merged in daemon#123,
// ceadfe2914; copied from daemon main 757e46e0b6) and omo-service. Update every copy together; a change here alone
// means the copies drifted (senpi#4421). senpi#4547 added the declaration-mirror rule here first; omo-relay-daemon and
// omo-service must take the same bytes and this pin.
const SHARED_PREPROCESSOR_SHA256 = "a2e2b471f196c3be85540199d437f700dec5ee21d607df32bb9c92978e041905";

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

// A declaration mirror X.d.mts / X.d.ts / X.d.cts is consumed through its runtime twin X.mjs / X.js / X.cjs, so knip
// reports the mirror's S unused while the twin's S is used. The mirror's S is dropped only when the twin exists, exports
// S, and is not reported unused for S itself.
const MIRROR_CASES = [
	{ name: "mirror symbol used via its .mjs twin is dropped", decl: "x.d.mts", twin: ["x.mjs", "export function S() {}\n"], unusedInTwin: [], kept: [] },
	{ name: "mirror symbol used via its .js twin is dropped", decl: "x.d.ts", twin: ["x.js", "const S = 1;\nexport { S };\n"], unusedInTwin: [], kept: [] },
	{ name: "mirror symbol used via its .cjs twin is dropped", decl: "x.d.cts", twin: ["x.cjs", "export const S = 1;\n"], unusedInTwin: [], kept: [] },
	{ name: "mirror symbol also unused in its twin is kept", decl: "x.d.mts", twin: ["x.mjs", "export function S() {}\n"], unusedInTwin: ["S"], kept: ["S"] },
	{ name: "mirror symbol unused in its twin but listed there as pre-existing is kept", decl: "x.d.mts", twin: ["x.mjs", "export function S() {}\n"], unusedInTwin: ["S"], listTwin: true, kept: ["S"] },
	{ name: "mirror with no twin is kept", decl: "x.d.mts", twin: undefined, unusedInTwin: [], kept: ["S"] },
	{ name: "mirror whose twin lacks the symbol is kept", decl: "x.d.mts", twin: ["x.mjs", "export function other() {}\n"], unusedInTwin: [], kept: ["S"] },
	{ name: "twin of a different module kind is not a twin", decl: "x.d.mts", twin: ["x.js", "export function S() {}\n"], unusedInTwin: [], kept: ["S"] },
	{ name: "plain .ts unused export beside a .js exporting it is kept", decl: "x.ts", twin: ["x.js", "export function S() {}\n"], unusedInTwin: [], kept: ["S"] },
];

for (const { name, decl, twin, unusedInTwin, listTwin, kept } of MIRROR_CASES)
	test(`declaration mirror: ${name}`, () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "knip-mirror-")));
		try {
			const issue = { type: "exports", workspace: ".", fixes: [] };
			const declPath = join(dir, "src", decl);
			const exports = { [declPath]: { S: { ...issue, filePath: declPath, symbol: "S" } } };
			mkdirSync(join(dir, "src"));
			if (twin !== undefined) {
				const twinPath = join(dir, "src", twin[0]);
				writeFileSync(twinPath, twin[1]);
				if (unusedInTwin.length > 0)
					exports[twinPath] = Object.fromEntries(unusedInTwin.map((symbol) => [symbol, { ...issue, filePath: twinPath, symbol }]));
			}
			const listed = listTwin ? { [`src/${twin[0]}`]: unusedInTwin } : {};
			const total = Object.values(exports).reduce((sum, symbols) => sum + Object.keys(symbols).length, 0);
			const result = preprocess({
				cwd: dir,
				preprocessorOptions: JSON.stringify({ preExistingExports: listed }),
				counters: { exports: total },
				issues: { exports },
			});
			assert.deepEqual(Object.keys(result.issues.exports[declPath] ?? {}), kept);
			const remaining = Object.values(result.issues.exports).reduce((sum, symbols) => sum + Object.keys(symbols).length, 0);
			assert.equal(result.counters.exports, remaining);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
