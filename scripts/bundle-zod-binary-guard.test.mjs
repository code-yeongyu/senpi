import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { assertBinaryZodCores } from "./bundle-zod-core-guard.mjs";
import { realZodOutput } from "./zod-real-output.test-support.mjs";

// senpi#6497 follow-up: `bun build --compile` embeds the bundled JS in the executable, so the compiled binaries get
// their own scan for stale zod cores: the Claude agent SDK's pinned 4.6.2 and its zod/v3 layer (one copy each, as a real
// compile embeds them) are allowed, anything else older than 4.6.6, and any further zod 3.x copy, fails the build.

const core = (version) => {
	const [, minor, patch] = version.split(".");
	return `var v={major:4,minor:${minor},patch:${patch}};`;
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

describe("compiled binary zod core guard", () => {
	it("accepts current cores and the SDK's pinned 4.6.2 copy", () => {
		withBinary(core("4.6.7") + core("4.6.2"), (file) => {
			assert.deepEqual(assertBinaryZodCores([file]).map((entry) => entry.version), ["4.6.2"]);
		});
	});

	it("fails on a second 4.6.2 copy", () => {
		withBinary(core("4.6.7") + core("4.6.2").repeat(2), (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /at most 1 zod 4\.6\.2 core\(s\), found 2/);
		});
	});

	it("fails on a 4.0.0 core", () => {
		withBinary(core("4.6.7") + core("4.0.0"), (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /outside the pinned exposures: .*pi 4\.0\.0/);
		});
	});

	it("fails on a real zod 3.25.76 copy, and accepts zod 4.6.7's zod/v3 layer", async () => {
		const zod3 = await realZodOutput("zod-3.25.76");
		const v4 = await realZodOutput("zod-4.6.7-v4");
		const v4v3 = await realZodOutput("zod-4.6.7-v3");
		// The SDK's own unpatched layer appears once in a compiled binary; a second copy is a new exposure.
		withBinary(v4 + zod3.repeat(2), (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /at most 1 zod 3\.x core\(s\), found 2/);
		});
		withBinary(v4 + zod3, (file) => {
			assert.equal(assertBinaryZodCores([file]).length, 1);
		});
		withBinary(v4 + v4v3, (file) => {
			assert.deepEqual(assertBinaryZodCores([file]), []);
		});
	});

	it("fails closed on a binary that embeds no zod core, or only stale ones", () => {
		withBinary("console.log(1)", (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /no current zod core/);
		});
		withBinary(core("4.6.2"), (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /no current zod core/);
		});
	});

	it("fails on a missing binary and on an empty argument list", () => {
		assert.throws(() => assertBinaryZodCores(["/nonexistent/senpi-pi"]), /unreadable/);
		assert.throws(() => assertBinaryZodCores([]), /no binary to scan/);
	});

	it("exits non-zero from the build-step script on a stale core and zero on a clean binary", () => {
		const script = new URL("./assert-binary-zod-cores.mjs", import.meta.url).pathname;
		withBinary(core("4.6.7"), (file) => {
			assert.equal(spawnSync("node", [script, file], { encoding: "utf8" }).status, 0);
		});
		withBinary(core("4.0.0"), (file) => {
			const result = spawnSync("node", [script, file], { encoding: "utf8" });
			assert.equal(result.status, 1);
			assert.match(result.stderr, /4\.0\.0/);
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
