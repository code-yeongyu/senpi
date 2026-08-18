import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("Claude Agent SDK platform binaries", () => {
	it("locks every native optional declared by the SDK", () => {
		const lock = readJson(join(root, "package-lock.json"));
		const sdk = lock.packages["packages/coding-agent/node_modules/@anthropic-ai/claude-agent-sdk"];
		assert.ok(sdk, "coding-agent lock must include @anthropic-ai/claude-agent-sdk");

		for (const [name, version] of Object.entries(sdk.optionalDependencies ?? {})) {
			const native = lock.packages[`node_modules/${name}`];
			assert.ok(native, `package-lock.json must include ${name}`);
			assert.equal(native.version, version, `${name} must match the SDK's exact version`);
			assert.equal(native.optional, true, `${name} must remain optional`);
		}
	});
});
