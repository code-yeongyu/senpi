import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("root tsgo dependency", () => {
	it("installs the native compiler binary used by workspace build scripts", () => {
		const manifest = readJson(join(root, "package.json"));
		const installLock = readJson(join(root, "package-lock.json"));
		const installedCompiler = installLock.packages["node_modules/@typescript/native"];

		// The root alias must point at native-preview, and the lock must install exactly that version.
		const spec = manifest.devDependencies["@typescript/native"];
		const [, aliasedName, aliasedVersion] = spec.match(/^npm:(@typescript\/native-preview)@(.+)$/) ?? [];
		assert.ok(aliasedVersion, `@typescript/native must alias native-preview, got ${spec}`);
		assert.equal(installLock.packages[""].devDependencies["@typescript/native"], spec);
		assert.equal(installedCompiler.name, aliasedName);
		assert.equal(installedCompiler.version, aliasedVersion);
		assert.equal(installedCompiler.bin.tsgo, "bin/tsgo");
	});
});
