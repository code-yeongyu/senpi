import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assertBinaryZodCores, describeStaleZodAllowances, PINNED_CLAUDE_AGENT_SDK_VERSION } from "./bundle-zod-core-guard.mjs";
import { realZodOutput } from "./zod-real-output.test-support.mjs";

// senpi#6497 follow-up: `bun build --compile` embeds the bundled JS in the executable, so the compiled binaries get
// their own scan for stale zod cores. The only stale zod allowed is the Claude agent SDK's: one 4.6.2 core and one
// unpatched zod/v3 layer per binary, under the pinned SDK version and source hashes. The binary's own bytes are not
// pinned: `bun build --compile` folds `process.platform` per target, so they differ between platforms.

const SDK = PINNED_CLAUDE_AGENT_SDK_VERSION;
const core = (version) => {
	const [, minor, patch] = version.split(".");
	return `var v={major:4,minor:${minor},patch:${patch}};`;
};

const ZOD3 = await realZodOutput("zod-3.25.76");
const SDK_COPY = `${core("4.6.2")}var a=1;${ZOD3}`;

const SDK_DIR = mkdtempSync(join(tmpdir(), "senpi-zod-binary-sdk-"));
writeFileSync(join(SDK_DIR, "package.json"), JSON.stringify({ version: SDK }));
writeFileSync(join(SDK_DIR, "sdk.mjs"), SDK_COPY);
const PINNED_SDK = { installed: SDK, locked: [SDK], dir: SDK_DIR };
const ALLOWANCE = {
	sdkVersion: SDK,
	sources: [{ path: "sdk.mjs", sha256: createHash("sha256").update(SDK_COPY).digest("hex"), stale: ["4.6.2", "3.x"] }],
	reachedSource: "sdk.mjs",
	bundle: [],
};

/** A fake executable: binary noise around the embedded JS text. */
function withBinary(embedded, check) {
	const dir = mkdtempSync(join(tmpdir(), "senpi-zod-binary-guard-"));
	const file = join(dir, "pi");
	writeFileSync(file, Buffer.concat([Buffer.from([0, 255, 128, 1, 2, 3]), Buffer.from(embedded, "latin1"), Buffer.from([0, 200])]));
	try {
		return check(file);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

const run = (file, allowance = ALLOWANCE, sdk = PINNED_SDK) => assertBinaryZodCores([file], allowance, sdk);

describe("compiled binary zod core guard", () => {
	it("accepts current cores plus the SDK's copies, and names the SDK version, source hash and copies", () => {
		withBinary(core("4.6.7") + SDK_COPY, (file) => {
			const result = run(file);
			assert.deepEqual(result.copies.map((entry) => entry.version), ["4.6.2", "3.x"]);
			const report = describeStaleZodAllowances(result);
			assert.equal(report[0], `pinned stale zod source: @anthropic-ai/claude-agent-sdk ${SDK} sdk.mjs sha256:${ALLOWANCE.sources[0].sha256} (zod 4.6.2 core, zod/v3 layer)`);
			assert.equal(report[1], `allowed stale zod copy: @anthropic-ai/claude-agent-sdk ${SDK} ${file} zod 4.6.2 core`);
			assert.equal(report[2], `allowed stale zod copy: @anthropic-ai/claude-agent-sdk ${SDK} ${file} zod/v3 layer`);
		});
	});

	it("accepts the SDK's copies with per-target folded bytes (process.platform rewritten by the compiler)", () => {
		withBinary(core("4.6.7") + SDK_COPY.replace("var a=1;", 'var a="darwin";'), (file) => {
			assert.equal(run(file).copies.length, 2);
		});
	});

	it("fails when the vendored SDK version differs from the pinned one", () => {
		withBinary(core("4.6.7") + SDK_COPY, (file) => {
			assert.throws(() => run(file, ALLOWANCE, { ...PINNED_SDK, installed: "0.3.322" }), /@anthropic-ai\/claude-agent-sdk 0\.3\.322 is installed.*pinned to 0\.3\.321/s);
		});
	});

	it("fails when the pinned SDK source file's bytes differ from the reviewed ones", () => {
		withBinary(core("4.6.7") + SDK_COPY, (file) => {
			const allowance = { ...ALLOWANCE, sources: [{ ...ALLOWANCE.sources[0], sha256: "0".repeat(64) }] };
			assert.throws(() => run(file, allowance), /sdk\.mjs: sha256:[0-9a-f]{64}, pinned sha256:0{64}/);
		});
	});

	it("fails on a second 4.6.2 copy", () => {
		withBinary(core("4.6.7") + SDK_COPY + core("4.6.2"), (file) => {
			assert.throws(() => run(file), /allowance: @anthropic-ai\/claude-agent-sdk 0\.3\.321 only.*expected stale zod \[4\.6\.2, 3\.x\], found \[4\.6\.2, 4\.6\.2, 3\.x\]/s);
		});
	});

	it("fails on a 4.0.0 core", () => {
		withBinary(core("4.6.7") + SDK_COPY + core("4.0.0"), (file) => {
			assert.throws(() => run(file), /found \[4\.0\.0, 4\.6\.2, 3\.x\]/);
		});
	});

	it("fails on a real zod 3.25.76 copy beyond the SDK's, and accepts zod 4.6.7's zod/v3 layer", async () => {
		const v4 = await realZodOutput("zod-4.6.7-v4");
		const v4v3 = await realZodOutput("zod-4.6.7-v3");
		withBinary(v4 + SDK_COPY + ZOD3, (file) => {
			assert.throws(() => run(file), /found \[4\.6\.2, 3\.x, 3\.x\]/);
		});
		withBinary(v4 + SDK_COPY + v4v3, (file) => {
			assert.equal(run(file).copies.length, 2);
		});
	});

	it("fails when the SDK's copies are missing from a binary, so the allowance is retired rather than forgotten", async () => {
		const v4 = await realZodOutput("zod-4.6.7-v4");
		withBinary(v4, (file) => {
			assert.throws(() => run(file), /expected stale zod \[4\.6\.2, 3\.x\], found \[\]; retire/);
		});
	});

	it("fails closed on a binary that embeds no zod core, or only stale ones", () => {
		withBinary("console.log(1)", (file) => {
			assert.throws(() => run(file), /no current zod core/);
		});
		withBinary(SDK_COPY, (file) => {
			assert.throws(() => run(file), /no current zod core/);
		});
	});

	it("fails on a missing binary and on an empty argument list", () => {
		assert.throws(() => assertBinaryZodCores(["/nonexistent/senpi-pi"], ALLOWANCE, PINNED_SDK), /unreadable/);
		assert.throws(() => assertBinaryZodCores([], ALLOWANCE, PINNED_SDK), /no binary to scan/);
	});

	it("exits non-zero from the build-step script, naming what is wrong", () => {
		const script = new URL("./assert-binary-zod-cores.mjs", import.meta.url).pathname;
		withBinary(core("4.0.0"), (file) => {
			const result = spawnSync("node", [script, file], { encoding: "utf8" });
			assert.equal(result.status, 1);
			assert.match(result.stderr, /4\.0\.0/);
		});
		withBinary(core("4.6.7"), (file) => {
			const result = spawnSync("node", [script, file], { encoding: "utf8" });
			assert.equal(result.status, 1);
			assert.match(result.stderr, /found \[\]; retire/);
		});
	});

	it("runs in build-binaries.sh after every compile, before archiving", () => {
		const script = readFileSync(new URL("./build-binaries.sh", import.meta.url), "utf8");
		const scan = script.indexOf("assert-binary-zod-cores.mjs");
		assert.notEqual(scan, -1);
		assert.ok(script.lastIndexOf("bun build --compile", scan) !== -1);
		assert.ok(scan < script.indexOf('echo "==> Creating release archives..."'));
	});
});
