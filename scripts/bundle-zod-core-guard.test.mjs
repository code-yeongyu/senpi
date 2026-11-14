import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	assertBundleZodCores,
	assertClaudeAgentSdkSources,
	describeStaleZodAllowances,
	PINNED_CLAUDE_AGENT_SDK_VERSION,
	readClaudeAgentSdkVersions,
	scanZodCores,
	STALE_ZOD_ALLOWANCE,
} from "./bundle-zod-core-guard.mjs";
import { realZodOutput } from "./zod-real-output.test-support.mjs";

// senpi#6497: the MCP client parses remote-server JSON-RPC with schemas built on the zod core its bundle carries.
// The only stale zod the scan allows is what the vendored Claude agent SDK embeds in its own published files: a 4.6.2
// core and an unpatched zod/v3 layer. The allowance pins the exact SDK version and the sha256 of those SOURCE files;
// in the bundle only placement, counts and versions are checked, so bundler renames cannot break the build.

const SDK = PINNED_CLAUDE_AGENT_SDK_VERSION;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const core = (version) => {
	const [, minor, patch] = version.split(".");
	return `var v={major:4,minor:${minor},patch:${patch}};`;
};

/** Real zod 3.25.76 output: what the SDK's unpatched `zod/v3` layer looks like to the scan. */
const ZOD3 = await realZodOutput("zod-3.25.76");

/** The two copies the SDK embeds: a 4.6.2 core, then the zod/v3 layer. */
const sdkCopy = (filler) => `/* sdk */${core("4.6.2")}${filler}${ZOD3}`;
const SDK_SOURCE = sdkCopy("var s=0;");

/** A fake installed SDK package whose sdk.mjs carries the copies; `files` overrides or adds package files. */
function sdkPackage(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-zod-sdk-"));
	for (const [name, text] of Object.entries({ "package.json": JSON.stringify({ version: SDK }), "sdk.mjs": SDK_SOURCE, ...files })) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}
const SDK_DIR = sdkPackage();
const PINNED_SDK = { installed: SDK, locked: [SDK], dir: SDK_DIR };
const ALLOWANCE = {
	sdkVersion: SDK,
	sources: [{ path: "sdk.mjs", sha256: sha(SDK_SOURCE), stale: ["4.6.2", "3.x"] }],
	reachedSource: "sdk.mjs",
	bundle: [/^chunks\/sdk-[^/]+\.js$/, "chunks/session-worker.js"],
};

function bundleWith(files) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-zod-core-guard-"));
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
	return dir;
}

const RELEASE_LAYOUT = {
	"cli.js": "console.log(1)",
	"chunks/chunk-FKX6EWFV.js": core("4.6.7"),
	"chunks/host-lifecycle.js": core("4.6.7"),
	"chunks/sdk-W3PQXNYH.js": sdkCopy("var a=1;"),
	"chunks/session-worker.js": `${core("4.6.7")}${sdkCopy("var b=2;")}`,
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

function withSdk(files, check) {
	const dir = sdkPackage(files);
	try {
		return check({ ...PINNED_SDK, dir });
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

const run = (dir, allowance = ALLOWANCE, sdk = PINNED_SDK) => assertBundleZodCores(dir, allowance, sdk);

describe("bundle zod core guard", () => {
	it("pins the version and source hashes of the Claude agent SDK the repository resolves and locks", () => {
		// The real installed package, against the PINNED constants (not values derived from the bytes being checked).
		const real = readClaudeAgentSdkVersions();
		assert.equal(STALE_ZOD_ALLOWANCE.sdkVersion, PINNED_CLAUDE_AGENT_SDK_VERSION);
		assert.equal(real.installed, PINNED_CLAUDE_AGENT_SDK_VERSION);
		assert.ok(real.locked.length >= 2, "bun.lock and package-lock.json both carry the SDK");
		assert.deepEqual([...new Set(real.locked)], [PINNED_CLAUDE_AGENT_SDK_VERSION]);
		for (const source of STALE_ZOD_ALLOWANCE.sources) {
			assert.equal(createHash("sha256").update(readFileSync(join(real.dir, source.path))).digest("hex"), source.sha256, source.path);
		}
		assert.deepEqual(
			assertClaudeAgentSdkSources(STALE_ZOD_ALLOWANCE, real).map((source) => `${source.path} ${source.stale.join(",")}`),
			STALE_ZOD_ALLOWANCE.sources.map((source) => `${source.path} ${source.stale.join(",")}`),
		);
		const reached = STALE_ZOD_ALLOWANCE.sources.find((source) => source.path === STALE_ZOD_ALLOWANCE.reachedSource);
		assert.deepEqual([reached.path, ...reached.stale], ["sdk.mjs", "4.6.2", "3.x"]);
	});

	it("accepts the release layout and names the SDK version, its source hashes and every allowed copy", () => {
		withBundle(RELEASE_LAYOUT, (dir) => {
			const result = run(dir);
			assert.deepEqual(
				result.copies.map((entry) => `${entry.file} ${entry.version}`),
				[
					"chunks/sdk-W3PQXNYH.js 4.6.2",
					"chunks/sdk-W3PQXNYH.js 3.x",
					"chunks/session-worker.js 4.6.2",
					"chunks/session-worker.js 3.x",
				],
			);
			const report = describeStaleZodAllowances(result);
			assert.equal(report[0], `pinned stale zod source: @anthropic-ai/claude-agent-sdk ${SDK} sdk.mjs sha256:${sha(SDK_SOURCE)} (zod 4.6.2 core, zod/v3 layer)`);
			assert.equal(report[1], `allowed stale zod copy: @anthropic-ai/claude-agent-sdk ${SDK} chunks/sdk-W3PQXNYH.js zod 4.6.2 core`);
			assert.equal(report.length, 5);
		});
	});

	it("still passes when an unrelated export is appended to the session worker (bundler renames are not pinned)", () => {
		const worker = `${RELEASE_LAYOUT["chunks/session-worker.js"].replace("var b=2;", "var b2=2;")}export const e = 1, t = 2, n = 3;`;
		withBundle({ ...RELEASE_LAYOUT, "chunks/session-worker.js": worker }, (dir) => {
			assert.equal(run(dir).copies.length, 4);
		});
	});

	it("fails when the vendored SDK version differs from the pinned one, naming the SDK and both versions", () => {
		withBundle(RELEASE_LAYOUT, (dir) => {
			assert.throws(() => run(dir, ALLOWANCE, { ...PINNED_SDK, installed: "0.3.322" }), /@anthropic-ai\/claude-agent-sdk 0\.3\.322 is installed.*pinned to 0\.3\.321/s);
			assert.throws(() => run(dir, ALLOWANCE, { ...PINNED_SDK, locked: [SDK, "0.3.322"] }), /@anthropic-ai\/claude-agent-sdk 0\.3\.322 is locked.*pinned to 0\.3\.321/s);
			assert.throws(() => run(dir, ALLOWANCE, { ...PINNED_SDK, installed: undefined }), /cannot read the installed @anthropic-ai\/claude-agent-sdk version/);
			assert.throws(() => run(dir, ALLOWANCE, { ...PINNED_SDK, locked: [] }), /no lockfile entry/);
		});
	});

	it("fails when one byte of a pinned SDK source file changes", () => {
		withSdk({ "sdk.mjs": SDK_SOURCE.replace("var s=0;", "var s=1;") }, (sdk) => {
			withBundle(RELEASE_LAYOUT, (dir) => {
				assert.throws(() => run(dir, ALLOWANCE, sdk), /sdk\.mjs: sha256:[0-9a-f]{64}, pinned sha256:[0-9a-f]{64}.*claude-agent-sdk 0\.3\.321/s);
			});
		});
	});

	it("fails when a pinned SDK source file is missing, and when another SDK file carries a stale copy", () => {
		withSdk({ "sdk.mjs": "export {};" }, (sdk) => {
			assert.throws(() => assertClaudeAgentSdkSources(ALLOWANCE, sdk), /sdk\.mjs: sha256/);
		});
		const dir = mkdtempSync(join(tmpdir(), "senpi-zod-sdk-"));
		writeFileSync(join(dir, "package.json"), "{}");
		try {
			assert.throws(() => assertClaudeAgentSdkSources(ALLOWANCE, { ...PINNED_SDK, dir }), /sdk\.mjs.*(unreadable|ENOENT)/);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
		withSdk({ "extra/bridge.mjs": core("4.6.2") }, (sdk) => {
			assert.throws(() => assertClaudeAgentSdkSources(ALLOWANCE, sdk), /extra\/bridge\.mjs.*not a pinned source/);
		});
	});

	it("fails when a pinned source no longer carries the stale copies its row names", () => {
		const changed = `${core("4.6.9")}${ZOD3}`;
		withSdk({ "sdk.mjs": changed }, (sdk) => {
			const allowance = { ...ALLOWANCE, sources: [{ path: "sdk.mjs", sha256: sha(changed), stale: ["4.6.2", "3.x"] }] };
			assert.throws(() => assertClaudeAgentSdkSources(allowance, sdk), /sdk\.mjs carries stale zod \[3\.x\], pinned \[4\.6\.2, 3\.x\]/);
		});
	});

	it("accepts a 4.6.6 or newer core anywhere", () => {
		withBundle({ ...RELEASE_LAYOUT, "cli.js": core("4.6.6"), "chunks/chunk-NEW.js": core("4.7.0") }, (dir) => {
			assert.doesNotThrow(() => run(dir));
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
					"chunks/session-worker.js 4.6.7",
					"chunks/session-worker.js 4.6.2",
					"chunks/session-worker.js 3.x",
					"host-supervisor.js 4.6.7",
				],
			);
		});
	});

	it("fails when the bundle directory is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "senpi-zod-core-guard-"));
		rmSync(dir, { recursive: true, force: true });
		assert.throws(() => run(dir), /unreadable/);
	});

	it("fails when the bundle has no emitted .js file", () => {
		withBundle({ "runtime-manifest.json": "{}" }, (dir) => {
			assert.throws(() => run(dir), /no emitted \.js file/);
		});
	});

	it("fails on a second 4.6.2 copy in the session worker", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/session-worker.js": RELEASE_LAYOUT["chunks/session-worker.js"] + core("4.6.2") }, (dir) => {
			assert.throws(() => run(dir), /allowance: @anthropic-ai\/claude-agent-sdk 0\.3\.321 only.*chunks\/session-worker\.js: expected stale zod \[4\.6\.2, 3\.x\], found \[4\.6\.2, 4\.6\.2, 3\.x\]/s);
		});
	});

	it("fails on an extra copy of the SDK's embedded zod in another chunk", () => {
		const sdkText = RELEASE_LAYOUT["chunks/sdk-W3PQXNYH.js"];
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-AX72VNRS.js": sdkText }, (dir) => {
			assert.throws(() => run(dir), /claude-agent-sdk 0\.3\.321 only.*outside the allowed files: chunks\/chunk-AX72VNRS\.js 4\.6\.2/s);
		});
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-OTHER.js": sdkText }, (dir) => {
			assert.throws(() => run(dir), /\/\^chunks\\\/sdk-.*: expected stale zod \[4\.6\.2, 3\.x\], found \[4\.6\.2, 4\.6\.2, 3\.x, 3\.x\]/);
		});
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-AX72VNRS.js": core("4.6.2") }, (dir) => {
			assert.throws(() => run(dir), /outside the allowed files: chunks\/chunk-AX72VNRS\.js 4\.6\.2/);
		});
	});

	it("fails on a 4.0.0 core, in the sdk chunk included", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": core("4.0.0") + RELEASE_LAYOUT["chunks/sdk-W3PQXNYH.js"] }, (dir) => {
			assert.throws(() => run(dir), /chunks\/sdk-W3PQXNYH\.js.*found \[4\.0\.0, 4\.6\.2, 3\.x\]/);
		});
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-FKX6EWFV.js": core("4.0.0") }, (dir) => {
			assert.throws(() => run(dir), /outside the allowed files: chunks\/chunk-FKX6EWFV\.js 4\.0\.0/);
		});
	});

	it("fails when an allowed file's copies are gone, so the allowance is retired rather than forgotten", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": core("4.6.7") }, (dir) => {
			assert.throws(() => run(dir), /expected stale zod \[4\.6\.2, 3\.x\], found \[\]; retire/);
		});
	});

	it("fails on a real zod 3.25.76 copy outside the allowed files, which carries no 4.x core banner", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-V3COPY.js": ZOD3 }, (dir) => {
			assert.throws(() => run(dir), /outside the allowed files: chunks\/chunk-V3COPY\.js 3\.x/);
		});
	});

	it("fails on a second zod 3.x copy in an allowed file", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/session-worker.js": RELEASE_LAYOUT["chunks/session-worker.js"] + ZOD3 }, (dir) => {
			assert.throws(() => run(dir), /chunks\/session-worker\.js: expected stale zod \[4\.6\.2, 3\.x\], found \[4\.6\.2, 3\.x, 3\.x\]/);
		});
	});

	it("does not flag the zod/v3 compatibility layer zod 4.6.7 ships, nor its zod/v4 core", async () => {
		const v3 = await realZodOutput("zod-4.6.7-v3");
		const v4 = await realZodOutput("zod-4.6.7-v4");
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-V4V3.js": v3, "chunks/chunk-V4V4.js": v4 }, (dir) => {
			assert.equal(scanZodCores(dir).filter((entry) => entry.file.startsWith("chunks/chunk-V4") && entry.version === "3.x").length, 0);
			assert.doesNotThrow(() => run(dir));
		});
	});
});
