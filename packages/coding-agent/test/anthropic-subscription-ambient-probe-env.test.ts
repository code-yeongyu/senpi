import { describe, expect, it } from "vitest";
import { probeAmbientClaudeAuthStatus } from "../src/core/extensions/builtin/anthropic-subscription/availability.ts";

describe("ambient Claude auth probe environment (senpi#1195)", () => {
	it("asks claude auth status without the host API key, so availability matches the turn lane", async () => {
		const seen: NodeJS.ProcessEnv[] = [];
		const available = await probeAmbientClaudeAuthStatus({
			env: {
				PATH: "/usr/bin",
				ANTHROPIC_API_KEY: "host-api-key",
				ANTHROPIC_BASE_URL: "https://gateway.invalid",
				SENPI_SEED: "host-seed",
			},
			spawnProbe: (_command, _args, env) => {
				seen.push(env);
				const child = {
					pid: 4242,
					once(event: "error" | "close", listener: (code: number | null) => void) {
						if (event === "close") queueMicrotask(() => listener(1));
						return child;
					},
					kill() {},
				};
				return child;
			},
		});

		expect(available).toBe(false);
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(seen[0]).not.toHaveProperty("SENPI_SEED");
		expect(seen[0]).toMatchObject({ PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://gateway.invalid" });
	});
});
