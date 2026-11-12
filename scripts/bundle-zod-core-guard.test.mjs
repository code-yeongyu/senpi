import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { assertBundleZodCores, EXPECTED_STALE_ZOD_CORES, scanZodCores } from "./bundle-zod-core-guard.mjs";
import { realZodOutput } from "./zod-real-output.test-support.mjs";

// senpi#6497: the MCP client parses remote-server JSON-RPC with schemas built on the zod core its bundle carries.
// The scan over the emitted files must fail on a missing or empty bundle and pin the exact stale copies it allows
// (the Claude agent SDK's embedded 4.6.2, once in its chunk and once in the session worker) with their counts.

const core = (version) => {
	const [, minor, patch] = version.split(".");
	return `var v={major:4,minor:${minor},patch:${patch}};`;
};

/** The emitted layout the release build produces today, plus the caller's overrides. */
function bundleWith(files) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-zod-core-guard-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

/** Real zod 3.25.76 output: what the SDK's unpatched `zod/v3` layer looks like to the scan. */
const ZOD3 = await realZodOutput("zod-3.25.76");

const RELEASE_LAYOUT = {
	"cli.js": "console.log(1)",
	"chunks/chunk-FKX6EWFV.js": core("4.6.7"),
	"chunks/host-lifecycle.js": core("4.6.7"),
	"chunks/sdk-W3PQXNYH.js": core("4.6.2") + ZOD3,
	"chunks/session-worker.js": core("4.6.2") + core("4.6.7") + ZOD3,
	"host-supervisor.js": core("4.6.7"),
	"runtime-manifest.json": "{}",
};

function withBundle(files, check) {
	const dir = bundleWith(files);
	try {
		return check(dir);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

describe("bundle zod core guard", () => {
	it("pins the Claude agent SDK's embedded copy once in its chunk and once in the session worker", () => {
		assert.deepEqual(
			EXPECTED_STALE_ZOD_CORES.map((row) => [String(row.file), row.version, row.count]),
			[
				["/^chunks\\/sdk-[^/]+\\.js$/", "4.6.2", 1],
				["chunks/session-worker.js", "4.6.2", 1],
				["/^chunks\\/sdk-[^/]+\\.js$/", "3.x", 1],
				["chunks/session-worker.js", "3.x", 1],
			],
		);
	});

	it("accepts the release layout and reports the stale copies it checked", () => {
		withBundle(RELEASE_LAYOUT, (dir) => {
			assert.deepEqual(
				assertBundleZodCores(dir).map((entry) => `${entry.file} ${entry.version}`),
				[
					"chunks/sdk-W3PQXNYH.js 4.6.2",
					"chunks/sdk-W3PQXNYH.js 3.x",
					"chunks/session-worker.js 4.6.2",
					"chunks/session-worker.js 3.x",
				],
			);
		});
	});

	it("accepts a 4.6.6 or newer core anywhere", () => {
		withBundle({ ...RELEASE_LAYOUT, "cli.js": core("4.6.6"), "chunks/chunk-NEW.js": core("4.7.0") }, (dir) => {
			assert.doesNotThrow(() => assertBundleZodCores(dir));
		});
	});

	it("scans the emitted .js files only, with forward-slash names", () => {
		withBundle(RELEASE_LAYOUT, (dir) => {
			assert.deepEqual(
				scanZodCores(dir).map((entry) => `${entry.file} ${entry.version}`),
				[
					"chunks/chunk-FKX6EWFV.js 4.6.7",
					"chunks/host-lifecycle.js 4.6.7",
					"chunks/sdk-W3PQXNYH.js 4.6.2",
					"chunks/sdk-W3PQXNYH.js 3.x",
					"chunks/session-worker.js 4.6.2",
					"chunks/session-worker.js 4.6.7",
					"chunks/session-worker.js 3.x",
					"host-supervisor.js 4.6.7",
				],
			);
		});
	});

	// The four bypass cases the review reproduced against the PR's first scan.
	it("fails when the bundle directory is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-zod-core-guard-"));
		rmSync(dir, { recursive: true, force: true });
		assert.throws(() => assertBundleZodCores(dir), /unreadable/);
	});

	it("fails when the bundle has no emitted .js file", () => {
		withBundle({ "runtime-manifest.json": "{}" }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /no emitted \.js file/);
		});
	});

	it("fails on a second 4.6.2 copy in the session worker", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/session-worker.js": core("4.6.2") + core("4.6.2") }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /expected 1 zod 4\.6\.2 core\(s\) in chunks\/session-worker\.js, found 2/);
		});
	});

	it("fails on a 4.6.2 copy in the chunk that carried the 4.0.0 core on main", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-AX72VNRS.js": core("4.6.2") }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /outside the pinned exposures: chunks\/chunk-AX72VNRS\.js 4\.6\.2/);
		});
	});

	it("fails on a 4.6.2 copy in a second sdk chunk", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-OTHER.js": core("4.6.2") }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /expected 1 zod 4\.6\.2 core\(s\) in \/\^chunks\\\/sdk-.*, found 2/);
		});
	});

	it("fails on a 4.0.0 core, in the sdk chunk included", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": core("4.0.0") + core("4.6.2") }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /outside the pinned exposures: chunks\/sdk-W3PQXNYH\.js 4\.0\.0/);
		});
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-FKX6EWFV.js": core("4.0.0") }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /chunks\/chunk-FKX6EWFV\.js 4\.0\.0/);
		});
	});

	it("fails when a pinned copy is gone, so the row is retired rather than forgotten", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": core("4.6.7") }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /found 0; retire the row/);
		});
	});

	// senpi#6497 follow-up: a stale zod 3.x classic copy (reached through `zod/v3`) carries no 4.x banner. The inputs are
	// real bundler output: zod 3.25.76, and zod 4.6.7's own `zod/v3` layer (the MCP SDK imports it), which must pass.
	it("fails on a real zod 3.25.76 copy outside the SDK's pinned files, which carries no 4.x core banner", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-V3COPY.js": ZOD3 }, (dir) => {
			assert.deepEqual(
				scanZodCores(dir)
					.filter((entry) => entry.version === "3.x" && entry.file === "chunks/chunk-V3COPY.js")
					.map((entry) => `${entry.file} ${entry.version}`),
				["chunks/chunk-V3COPY.js 3.x"],
			);
			assert.throws(() => assertBundleZodCores(dir), /outside the pinned exposures: chunks\/chunk-V3COPY\.js 3\.x/);
		});
	});

	it("fails on a second zod 3.x copy in a file that pins one", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/session-worker.js": RELEASE_LAYOUT["chunks/session-worker.js"] + ZOD3 }, (dir) => {
			assert.throws(() => assertBundleZodCores(dir), /expected 1 zod 3\.x core\(s\) in chunks\/session-worker\.js, found 2/);
		});
	});

	it("does not flag the zod/v3 compatibility layer zod 4.6.7 ships, nor its zod/v4 core", async () => {
		const v3 = await realZodOutput("zod-4.6.7-v3");
		const v4 = await realZodOutput("zod-4.6.7-v4");
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-V4V3.js": v3, "chunks/chunk-V4V4.js": v4 }, (dir) => {
			assert.equal(scanZodCores(dir).filter((entry) => entry.file.startsWith("chunks/chunk-V4")).filter((entry) => entry.version === "3.x").length, 0);
			assert.doesNotThrow(() => assertBundleZodCores(dir));
		});
	});
});
