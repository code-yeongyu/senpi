import { apiKeyEnvProviders, getEnvApiKey, type ProviderEnv } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { discoverEnvSlots } from "../../src/core/credential-pool/env-slots.ts";
import { daemonEnvIsAllowed, daemonEnvironment } from "../../src/modes/rpc/host-daemon-env.ts";

const PLATFORMS = ["linux", "darwin", "win32"] as const satisfies readonly NodeJS.Platform[];
const PROVIDERS = [...apiKeyEnvProviders(), "google-vertex", "amazon-bedrock", "anthropic-subscription"];

/**
 * Every environment name the engine's own credential lookup reads, captured by running that lookup
 * against an environment that records each access: once with every name unset (every `||` operand
 * is read) and once with every name set (every `&&` operand is read). A name added to the lookup
 * later is captured here without editing this test.
 */
function namesTheLookupReads(): Set<string> {
	const read = new Set<string>();
	const recording = (value: string | undefined) =>
		new Proxy<ProviderEnv>(
			{},
			{
				get(_target, name) {
					if (typeof name === "string") read.add(name);
					return value;
				},
			},
		);
	for (const value of [undefined, "set"]) {
		for (const provider of PROVIDERS) {
			getEnvApiKey(provider, recording(value));
			discoverEnvSlots(provider, (name) => {
				read.add(name);
				return value;
			});
		}
	}
	return read;
}

describe("a host daemon inherits every credential the engine reads (senpi#3531)", () => {
	it("passes every name the provider credential lookup reads, on every platform", () => {
		const read = namesTheLookupReads();
		expect(read.size).toBeGreaterThan(40);
		for (const platform of PLATFORMS) {
			const dropped = [...read].filter((name) => !daemonEnvIsAllowed(name, platform));
			expect(dropped, platform).toEqual([]);
		}
	});

	it("hands a Claude subscription token and its numbered slot to the daemon", () => {
		const env = daemonEnvironment(
			{ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "token-1", CLAUDE_CODE_OAUTH_TOKEN_2: "token-2" },
			{},
			{},
			"darwin",
		);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-1");
		expect(env.CLAUDE_CODE_OAUTH_TOKEN_2).toBe("token-2");
	});

	it("still drops a secret the engine never reads, and a slot past the last index", () => {
		for (const name of ["DATABASE_URL", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_17", "HF_TOKEN_17"]) {
			expect(daemonEnvIsAllowed(name, "linux"), name).toBe(false);
		}
	});
});
