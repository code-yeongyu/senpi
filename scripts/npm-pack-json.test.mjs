import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNpmPackJson } from "./npm-pack-json.mjs";

describe("npm pack JSON parsing", () => {
	it("ignores npm workspace warnings before the pack result", () => {
		const output = `npm warn config ignoring workspace config at /tmp/package/.npmrc
npm warn Unknown user config "auto-install-peers". This will stop working in the next major version of npm.
[
  {
    "id": "@code-yeongyu/senpi-telemetry@2026.8.13",
    "filename": "code-yeongyu-senpi-telemetry-2026.8.13.tgz"
  }
]
npm warn Unknown project config "legacy-peer-deps". This will stop working in the next major version of npm.`;

		assert.deepEqual(parseNpmPackJson(output), [
			{
				id: "@code-yeongyu/senpi-telemetry@2026.8.13",
				filename: "code-yeongyu-senpi-telemetry-2026.8.13.tgz",
			},
		]);
	});

	it("rejects output without a pack-result array", () => {
		assert.throws(() => parseNpmPackJson("npm warn no json followed"), /did not return a JSON array/u);
	});
});
