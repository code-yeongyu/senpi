import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("coding-agent signal-exit dependency", () => {
	it("pins the callable major required by proper-lockfile", () => {
		const manifest = readJson(join(root, "packages", "coding-agent", "package.json"));
		const installLock = readJson(join(root, "package-lock.json"));
		const isolatedInstallLock = readJson(
			join(root, "packages", "coding-agent", "install-lock", "package-lock.json"),
		);
		const publishLock = readJson(join(root, "packages", "coding-agent", "publish-deps.lock.json"));

		assert.equal(manifest.dependencies["proper-lockfile"], "4.1.2");
		assert.equal(manifest.dependencies["signal-exit"], "3.0.7");
		assert.equal(installLock.packages["packages/coding-agent"].dependencies["signal-exit"], "3.0.7");
		assert.equal(
			isolatedInstallLock.packages["node_modules/@code-yeongyu/senpi"].dependencies["signal-exit"],
			"3.0.7",
		);
		assert.equal(isolatedInstallLock.packages["node_modules/signal-exit"].version, "3.0.7");
		assert.equal(publishLock.packages[""].dependencies["signal-exit"], "3.0.7");
		assert.equal(publishLock.packages["node_modules/signal-exit"].version, "3.0.7");
	});
});
