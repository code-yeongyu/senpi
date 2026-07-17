import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessageEvent,
	fauxAssistantMessage,
	registerFauxProvider,
	type Tool,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const bashTool: Tool = {
	name: "bash",
	description: "Run a shell command",
	parameters: Type.Object({ command: Type.String() }),
};

const registrations: Array<{ unregister(): void }> = [];
let tempDir: string | undefined;

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
	if (tempDir !== undefined) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createComposedCustomProvider() {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-composed-tool-call-format-"));
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				mock: {
					api: "openai-completions",
					apiKey: "test-key",
					baseUrl: "https://example.invalid/v1",
					compat: { toolCallFormat: "anthropic-xml" },
					models: [{ id: "mock-model" }],
				},
			},
		}),
	);

	const provider = composeModelProvider("mock", undefined, ModelConfig.loadSync(modelsPath), undefined);
	const model = provider.getModels()[0];
	if (model === undefined) throw new Error("Expected the models.json custom model");
	return { provider, model };
}

describe("composed custom provider text tool-call compatibility", () => {
	it.each(["stream", "streamSimple"] as const)("parses anthropic-xml calls through %s", async (method) => {
		const faux = registerFauxProvider({
			api: "openai-completions",
			tokenSize: { min: 1, max: 1 },
			schedulerHook: () => undefined,
		});
		registrations.push(faux);
		const invocation = '<invoke name="bash"><parameter name="command">echo composed-provider</parameter></invoke>';
		faux.setResponses([fauxAssistantMessage(invocation)]);
		const { provider, model } = createComposedCustomProvider();

		const stream =
			method === "stream"
				? provider.stream(model, {
						messages: [{ role: "user", content: "Run bash", timestamp: 0 }],
						tools: [bashTool],
					})
				: provider.streamSimple(model, {
						messages: [{ role: "user", content: "Run bash", timestamp: 0 }],
						tools: [bashTool],
					});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();

		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "anthropic-xml-tool-0",
				name: "bash",
				arguments: { command: "echo composed-provider" },
			},
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(faux.state.callCount).toBe(1);
		expect(faux.getCallLog()[0]?.context.tools).toBeUndefined();
	});
});
