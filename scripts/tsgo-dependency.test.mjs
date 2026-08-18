import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const nativeCompiler = "npm:@typescript/native-preview@7.0.0-dev.20260707.2";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("root tsgo dependency", () => {
	it("installs the native compiler binary used by workspace build scripts", () => {
		const manifest = readJson(join(root, "package.json"));
		const installLock = readJson(join(root, "package-lock.json"));
		const installedCompiler = installLock.packages["node_modules/@typescript/native"];

		assert.equal(manifest.devDependencies["@typescript/native"], nativeCompiler);
		assert.equal(installLock.packages[""].devDependencies["@typescript/native"], nativeCompiler);
		assert.equal(installedCompiler.name, "@typescript/native-preview");
		assert.equal(installedCompiler.version, "7.0.0-dev.20260707.2");
		assert.equal(installedCompiler.bin.tsgo, "bin/tsgo");
	});
});
