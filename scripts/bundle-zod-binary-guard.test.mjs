import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { assertBinaryZodCores } from "./bundle-zod-core-guard.mjs";

// senpi#6497 follow-up: `bun build --compile` embeds the bundled JS in the executable, so the compiled binaries get
// their own scan for stale zod cores: the Claude agent SDK's pinned 4.6.2 (at most the two copies the bundle pins) is
// allowed, anything else older than 4.6.6, and any zod 3.x copy, fails the build.

const core = (version) => {
	const [, minor, patch] = version.split(".");
	return `var v={major:4,minor:${minor},patch:${patch}};`;
};
const ZOD3_COPY = 'var e;(function(r){r.ZodEffects="ZodEffects"})(e||(e={}));';

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
	it("accepts current cores and the SDK's pinned 4.6.2 copies", () => {
		withBinary(core("4.6.7") + core("4.6.2") + core("4.6.2"), (file) => {
			assert.deepEqual(assertBinaryZodCores([file]).map((entry) => entry.version), ["4.6.2", "4.6.2"]);
		});
	});

	it("fails on a third 4.6.2 copy", () => {
		withBinary(core("4.6.2").repeat(3), (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /at most 2 zod 4\.6\.2 core\(s\), found 3/);
		});
	});

	it("fails on a 4.0.0 core", () => {
		withBinary(core("4.6.7") + core("4.0.0"), (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /outside the pinned exposures: .*pi 4\.0\.0/);
		});
	});

	it("fails on a zod 3.x copy", () => {
		withBinary(core("4.6.7") + ZOD3_COPY, (file) => {
			assert.throws(() => assertBinaryZodCores([file]), /outside the pinned exposures: .*pi 3\.x/);
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
