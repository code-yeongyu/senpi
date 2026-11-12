import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	assertBundleZodCores,
	describeStaleZodAllowances,
	PINNED_CLAUDE_AGENT_SDK_VERSION,
	readClaudeAgentSdkVersions,
	scanZodCores,
	STALE_ZOD_ALLOWANCE,
} from "./bundle-zod-core-guard.mjs";
import { realZodOutput } from "./zod-real-output.test-support.mjs";

// senpi#6497: the MCP client parses remote-server JSON-RPC with schemas built on the zod core its bundle carries.
// The only stale zod the scan allows is what the vendored Claude agent SDK embeds: a 4.6.2 core and an unpatched zod/v3
// layer. The allowance is pinned to the exact SDK version AND to the sha256 of each allowed copy's bytes, so a changed
// SDK, a changed copy, a copy in another file or a different count all fail, and a pass names every copy it allowed.

const SDK = PINNED_CLAUDE_AGENT_SDK_VERSION;
const PINNED_SDK = { installed: SDK, locked: [SDK] };
const V3_WINDOW = 32768;
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const core = (version) => {
	const [, minor, patch] = version.split(".");
	return `var v={major:4,minor:${minor},patch:${patch}};`;
};

/** Real zod 3.25.76 output: what the SDK's unpatched `zod/v3` layer looks like to the scan. */
const ZOD3 = await realZodOutput("zod-3.25.76");
const V3_MARKER = /Extended_Pictographic\}\|\\{1,2}p\{Emoji_Component\}\)\+\$/;

/** The two copies the SDK embeds, as the test builds them: a 4.6.2 core up to the zod/v3 layer, then the layer. */
const sdkCopy = (filler) => `/* sdk */${core("4.6.2")}${filler}${ZOD3}`;

/** The pinned rows an independent reader derives from `text`: core = banner..zod/v3 marker, v3 = marker..+32 KiB. */
function segmentsOf(text) {
	const banner = text.search(/major:\s*4,\s*minor:\s*6,\s*patch:\s*2/);
	const marker = text.search(V3_MARKER);
	return { core: sha(text.slice(banner, marker)), v3: sha(text.slice(marker, marker + V3_WINDOW)) };
}

function allowanceFor(files) {
	const sdk = segmentsOf(files["chunks/sdk-W3PQXNYH.js"]);
	const worker = segmentsOf(files["chunks/session-worker.js"]);
	return {
		sdkVersion: SDK,
		bundle: [
			{ file: /^chunks\/sdk-[^/]+\.js$/, version: "4.6.2", sha256: sdk.core },
			{ file: "chunks/session-worker.js", version: "4.6.2", sha256: worker.core },
			{ file: /^chunks\/sdk-[^/]+\.js$/, version: "3.x", sha256: sdk.v3 },
			{ file: "chunks/session-worker.js", version: "3.x", sha256: worker.v3 },
		],
		binary: [],
	};
}

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
const ALLOWANCE = allowanceFor(RELEASE_LAYOUT);

function withBundle(files, check) {
	const dir = bundleWith(files);
	try {
		return check(dir);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

const run = (dir, allowance = ALLOWANCE, sdk = PINNED_SDK) => assertBundleZodCores(dir, allowance, sdk);

describe("bundle zod core guard", () => {
	it("pins the allowance to the Claude agent SDK version the repository resolves and locks", () => {
		const real = readClaudeAgentSdkVersions();
		assert.equal(STALE_ZOD_ALLOWANCE.sdkVersion, PINNED_CLAUDE_AGENT_SDK_VERSION);
		assert.equal(real.installed, PINNED_CLAUDE_AGENT_SDK_VERSION);
		assert.ok(real.locked.length >= 2, "bun.lock and package-lock.json both carry the SDK");
		assert.deepEqual([...new Set(real.locked)], [PINNED_CLAUDE_AGENT_SDK_VERSION]);
		assert.deepEqual(
			STALE_ZOD_ALLOWANCE.bundle.map((row) => [String(row.file), row.version, /^[0-9a-f]{64}$/.test(row.sha256)]),
			[
				["/^chunks\\/sdk-[^/]+\\.js$/", "4.6.2", true],
				["chunks/session-worker.js", "4.6.2", true],
				["/^chunks\\/sdk-[^/]+\\.js$/", "3.x", true],
				["chunks/session-worker.js", "3.x", true],
			],
		);
		assert.deepEqual(
			STALE_ZOD_ALLOWANCE.binary.map((row) => [row.version, /^[0-9a-f]{64}$/.test(row.sha256)]),
			[
				["4.6.2", true],
				["3.x", true],
			],
		);
	});

	it("accepts the release layout and names every allowed copy with SDK version, file and hash", () => {
		withBundle(RELEASE_LAYOUT, (dir) => {
			const checked = run(dir);
			assert.deepEqual(
				checked.map((entry) => `${entry.file} ${entry.version}`),
				[
					"chunks/sdk-W3PQXNYH.js 4.6.2",
					"chunks/sdk-W3PQXNYH.js 3.x",
					"chunks/session-worker.js 4.6.2",
					"chunks/session-worker.js 3.x",
				],
			);
			const report = describeStaleZodAllowances(SDK, checked);
			assert.equal(report.length, 4);
			const sdkChunk = segmentsOf(RELEASE_LAYOUT["chunks/sdk-W3PQXNYH.js"]);
			assert.equal(report[0], `allowed stale zod copy: @anthropic-ai/claude-agent-sdk ${SDK} chunks/sdk-W3PQXNYH.js zod 4.6.2 core sha256:${sdkChunk.core}`);
			assert.equal(report[1], `allowed stale zod copy: @anthropic-ai/claude-agent-sdk ${SDK} chunks/sdk-W3PQXNYH.js zod/v3 layer sha256:${sdkChunk.v3}`);
		});
	});

	it("accepts the real SDK bytes (sdk.mjs from the resolved package) as the sdk chunk", () => {
		const real = readFileSync(readClaudeAgentSdkVersions().sdkMjs, "utf8");
		const files = { ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": real };
		withBundle(files, (dir) => {
			const checked = run(dir, allowanceFor(files));
			assert.equal(checked.filter((entry) => entry.file === "chunks/sdk-W3PQXNYH.js").length, 2);
			assert.equal(checked.find((entry) => entry.version === "4.6.2" && entry.file === "chunks/sdk-W3PQXNYH.js").sha256, segmentsOf(real).core);
		});
	});

	it("fails when the vendored SDK version differs from the pinned one, naming the SDK and both versions", () => {
		withBundle(RELEASE_LAYOUT, (dir) => {
			assert.throws(() => run(dir, ALLOWANCE, { installed: "0.3.322", locked: [SDK] }), /@anthropic-ai\/claude-agent-sdk 0\.3\.322 is installed.*pinned to 0\.3\.321/s);
			assert.throws(() => run(dir, ALLOWANCE, { installed: SDK, locked: [SDK, "0.3.322"] }), /@anthropic-ai\/claude-agent-sdk 0\.3\.322 is locked.*pinned to 0\.3\.321/s);
			assert.throws(() => run(dir, ALLOWANCE, { installed: undefined, locked: [SDK] }), /cannot read the installed @anthropic-ai\/claude-agent-sdk version/);
			assert.throws(() => run(dir, ALLOWANCE, { installed: SDK, locked: [] }), /no lockfile entry/);
		});
	});

	it("fails when one byte inside an allowed core or zod/v3 copy changes", () => {
		const sdk = RELEASE_LAYOUT["chunks/sdk-W3PQXNYH.js"];
		const inCore = sdk.replace("var a=1;", "var a=2;");
		assert.notEqual(inCore, sdk);
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": inCore }, (dir) => {
			assert.throws(() => run(dir), /chunks\/sdk-W3PQXNYH\.js: zod 4\.6\.2 core bytes changed.*claude-agent-sdk 0\.3\.321/s);
		});
		const worker = RELEASE_LAYOUT["chunks/session-worker.js"];
		const marker = worker.search(V3_MARKER);
		const inV3 = `${worker.slice(0, marker + 200)}${worker[marker + 200] === "x" ? "y" : "x"}${worker.slice(marker + 201)}`;
		withBundle({ ...RELEASE_LAYOUT, "chunks/session-worker.js": inV3 }, (dir) => {
			assert.throws(() => run(dir), /chunks\/session-worker\.js: zod\/v3 layer bytes changed/);
		});
	});

	it("accepts a 4.6.6 or newer core anywhere", () => {
		withBundle({ ...RELEASE_LAYOUT, "cli.js": core("4.6.6"), "chunks/chunk-NEW.js": core("4.7.0") }, (dir) => {
			assert.doesNotThrow(() => run(dir));
		});
	});

	it("scans the emitted .js files only, with forward-slash names and a hash per stale copy", () => {
		withBundle(RELEASE_LAYOUT, (dir) => {
			const found = scanZodCores(dir);
			assert.deepEqual(
				found.map((entry) => `${entry.file} ${entry.version}`),
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
			assert.ok(found.filter((entry) => entry.major === 3 || entry.minor < 6).every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)));
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
			assert.throws(() => run(dir), /allowance: @anthropic-ai\/claude-agent-sdk 0\.3\.321 only.*expected 1 zod 4\.6\.2 core in chunks\/session-worker\.js, found 2/s);
		});
	});

	it("fails on an extra copy of the SDK's embedded zod in another chunk, byte-identical or not", () => {
		const sdkText = RELEASE_LAYOUT["chunks/sdk-W3PQXNYH.js"];
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-AX72VNRS.js": sdkText }, (dir) => {
			assert.throws(() => run(dir), /claude-agent-sdk 0\.3\.321 only.*outside the pinned exposures: chunks\/chunk-AX72VNRS\.js 4\.6\.2 sha256:[0-9a-f]{64}/s);
		});
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-OTHER.js": sdkText }, (dir) => {
			assert.throws(() => run(dir), /expected 1 zod 4\.6\.2 core in \/\^chunks\\\/sdk-.*, found 2/);
		});
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-AX72VNRS.js": core("4.6.2") }, (dir) => {
			assert.throws(() => run(dir), /outside the pinned exposures: chunks\/chunk-AX72VNRS\.js 4\.6\.2/);
		});
	});

	it("fails on a 4.0.0 core, in the sdk chunk included", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": core("4.0.0") + RELEASE_LAYOUT["chunks/sdk-W3PQXNYH.js"] }, (dir) => {
			assert.throws(() => run(dir), /outside the pinned exposures: chunks\/sdk-W3PQXNYH\.js 4\.0\.0/);
		});
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-FKX6EWFV.js": core("4.0.0") }, (dir) => {
			assert.throws(() => run(dir), /chunks\/chunk-FKX6EWFV\.js 4\.0\.0/);
		});
	});

	it("fails when a pinned copy is gone, so the row is retired rather than forgotten", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/sdk-W3PQXNYH.js": core("4.6.7") }, (dir) => {
			assert.throws(() => run(dir), /found 0; retire the row/);
		});
	});

	it("fails on a real zod 3.25.76 copy outside the SDK's pinned files, which carries no 4.x core banner", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-V3COPY.js": ZOD3 }, (dir) => {
			assert.deepEqual(
				scanZodCores(dir)
					.filter((entry) => entry.version === "3.x" && entry.file === "chunks/chunk-V3COPY.js")
					.map((entry) => `${entry.file} ${entry.version}`),
				["chunks/chunk-V3COPY.js 3.x"],
			);
			assert.throws(() => run(dir), /outside the pinned exposures: chunks\/chunk-V3COPY\.js 3\.x/);
		});
	});

	it("fails on a second zod 3.x copy in a file that pins one", () => {
		withBundle({ ...RELEASE_LAYOUT, "chunks/session-worker.js": RELEASE_LAYOUT["chunks/session-worker.js"] + ZOD3 }, (dir) => {
			assert.throws(() => run(dir), /expected 1 zod\/v3 layer in chunks\/session-worker\.js, found 2/);
		});
	});

	it("does not flag the zod/v3 compatibility layer zod 4.6.7 ships, nor its zod/v4 core", async () => {
		const v3 = await realZodOutput("zod-4.6.7-v3");
		const v4 = await realZodOutput("zod-4.6.7-v4");
		withBundle({ ...RELEASE_LAYOUT, "chunks/chunk-V4V3.js": v3, "chunks/chunk-V4V4.js": v4 }, (dir) => {
			assert.equal(scanZodCores(dir).filter((entry) => entry.file.startsWith("chunks/chunk-V4")).filter((entry) => entry.version === "3.x").length, 0);
			assert.doesNotThrow(() => run(dir));
		});
	});
});
