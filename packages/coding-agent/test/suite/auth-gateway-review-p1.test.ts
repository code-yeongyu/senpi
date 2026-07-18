import { describe, expect, it } from "vitest";
import {
	AuthGatewayBrokerConfigError,
	assertBrokerUrlAllowed,
	brokerConfig,
} from "../../src/cli/auth-gateway-broker-client.ts";
import { modelForRequest } from "../../src/core/auth-gateway-model-select.ts";

describe("auth gateway review P1", () => {
	it("rejects non-loopback http broker URLs before any token is used", async () => {
		expect(() => assertBrokerUrlAllowed("http://evil.example/broker")).toThrow(/loopback/i);
		expect(() => assertBrokerUrlAllowed("http://127.0.0.1:7432")).not.toThrow();
		expect(() => assertBrokerUrlAllowed("https://broker.example")).not.toThrow();
		await expect(
			brokerConfig({ brokerUrl: "http://evil.example", brokerToken: "x".repeat(40) }, "/tmp", true),
		).rejects.toBeInstanceOf(AuthGatewayBrokerConfigError);
	});

	it("resolves qualified provider/model for chat and messages fields", () => {
		const models = [
			{ provider: "openai", modelId: "gpt-4.1", api: "openai-completions" },
			{ provider: "anthropic", modelId: "claude-sonnet-4", api: "anthropic-messages" },
		] as never;
		expect(modelForRequest(models, { model: "openai/gpt-4.1" }, "model")).toMatchObject({
			provider: "openai",
			modelId: "gpt-4.1",
		});
		expect(modelForRequest(models, { model: "gpt-4.1" }, "model")).toMatchObject({
			provider: "openai",
			modelId: "gpt-4.1",
		});
		expect(modelForRequest(models, { model: "missing/nope" }, "model")).toBeUndefined();
	});
});
