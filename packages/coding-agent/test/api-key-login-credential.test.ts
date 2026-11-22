import type { Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { apiKeyLoginCredential } from "../src/modes/rpc/api-key-login-credential.ts";

const providerAsking = (selects: number): Provider =>
	({
		name: "Two Questions",
		auth: {
			apiKey: {
				name: "Two Questions key",
				login: async (interaction: ProviderAuthInteraction) => {
					const answers: string[] = [];
					for (let index = 0; index < selects; index++) {
						answers.push(
							await interaction.prompt({
								type: "select",
								message: `question ${index}`,
								options: [{ id: "global", label: "Global" }],
							}),
						);
					}
					const key = await interaction.prompt({ type: "secret", message: "key" });
					return { type: "api_key", key, env: { ANSWERS: answers.join(",") } };
				},
			},
		},
	}) as unknown as Provider;

describe("apiKeyLoginCredential", () => {
	it("answers the region to the first select only and refuses a second one", async () => {
		await expect(apiKeyLoginCredential(providerAsking(1), "sk-one", "global")).resolves.toEqual({
			type: "api_key",
			key: "sk-one",
			env: { ANSWERS: "global" },
		});
		await expect(apiKeyLoginCredential(providerAsking(2), "sk-two", "global")).rejects.toThrow(
			"asked for more than a key and a region",
		);
	});
});
