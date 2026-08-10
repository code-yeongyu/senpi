import { describe, expect, it } from "vitest";
import { nativeAgentEnvironment, runAcpAgent } from "../src/core/extensions/builtin/native-agent-sdk/acp-boundary.ts";

describe("native agent ACP boundary", () => {
	it("passes only runtime and provider-specific credential variables", () => {
		const environment = nativeAgentEnvironment(["XAI_API_KEY"], {
			PATH: "/bin",
			HOME: "/home/test",
			XAI_API_KEY: "xai-test",
			OPENAI_API_KEY: "must-not-leak",
			AWS_SECRET_ACCESS_KEY: "must-not-leak",
		});

		expect(environment).toEqual({
			PATH: "/bin",
			HOME: "/home/test",
			XAI_API_KEY: "xai-test",
		});
	});

	it("surfaces a missing ACP executable as a rejected turn", async () => {
		const collect = async (): Promise<void> => {
			for await (const _event of runAcpAgent(
				{ model: "test-model", prompt: "test", cwd: process.cwd() },
				"senpi-definitely-missing-acp-command",
				[],
				"senpi-test",
				[],
			)) {
			}
		};

		await expect(collect()).rejects.toThrow();
	});

	it("rejects a pre-aborted request before spawning the runtime", async () => {
		const controller = new AbortController();
		controller.abort();
		const collect = async (): Promise<void> => {
			for await (const _event of runAcpAgent(
				{
					model: "test-model",
					prompt: "test",
					cwd: process.cwd(),
					signal: controller.signal,
				},
				"senpi-command-must-not-spawn",
				[],
				"senpi-test",
				[],
			)) {
			}
		};

		await expect(collect()).rejects.toThrow("Operation aborted");
	});
});
