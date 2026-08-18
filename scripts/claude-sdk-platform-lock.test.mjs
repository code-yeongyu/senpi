import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const sdkLockPath = "packages/coding-agent/node_modules/@anthropic-ai/claude-agent-sdk";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("Claude Agent SDK platform binaries", () => {
	it("locks every native optional declared by the Claude Agent SDK", () => {
		const lock = readJson(join(root, "package-lock.json"));
		const sdk = lock.packages[sdkLockPath];
		assert.ok(sdk, `${sdkLockPath} must be present in the root lock`);

		for (const [packageName, version] of Object.entries(sdk.optionalDependencies)) {
			const binary = lock.packages[`node_modules/${packageName}`];
			assert.ok(
				binary,
				`${packageName} must be present in the root lock. CI installs with \`npm ci\`, which resolves ` +
					"strictly from this file, so a missing entry leaves that platform without the Claude native " +
					"binary and every claude-sdk-oauth test fails there with an empty transcript.",
			);
			assert.equal(binary.version, version);
			assert.equal(binary.optional, true);
			assert.match(binary.resolved, /^https:\/\/registry\.npmjs\.org\//u);
			assert.match(binary.integrity, /^sha512-/u);
		}
	});

	it("covers the platforms the executable resolver probes", () => {
		const lock = readJson(join(root, "package-lock.json"));
		const sdk = lock.packages[sdkLockPath];
		const locked = new Set(Object.keys(sdk.optionalDependencies));

		for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-x64-musl", "win32-x64"]) {
			assert.ok(
				locked.has(`@anthropic-ai/claude-agent-sdk-${platform}`),
				`the SDK must still declare a ${platform} binary`,
			);
		}
	});
});
