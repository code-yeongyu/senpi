import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveOptionalRegistryPackage } from "./publish-lock-optional-registry.mjs";

describe("resolveOptionalRegistryPackage", () => {
	it("resolves an exact-version platform optional package absent from the host lock", async () => {
		const requests = [];
		const entry = await resolveOptionalRegistryPackage(
			"@anthropic-ai/claude-agent-sdk-darwin-x64",
			"0.3.220",
			{
				fetchPackage: async (packageName, version) => {
					requests.push({ packageName, version });
					return {
						name: packageName,
						version,
						dist: {
							integrity: "sha512-test",
							tarball:
								"https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-0.3.220.tgz",
						},
						os: ["darwin"],
						cpu: ["x64"],
					};
				},
			},
		);

		assert.deepEqual(requests, [
			{
				packageName: "@anthropic-ai/claude-agent-sdk-darwin-x64",
				version: "0.3.220",
			},
		]);
		assert.deepEqual(entry, {
			version: "0.3.220",
			resolved:
				"https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-x64/-/claude-agent-sdk-darwin-x64-0.3.220.tgz",
			integrity: "sha512-test",
			os: ["darwin"],
			cpu: ["x64"],
			optional: true,
		});
	});
});
