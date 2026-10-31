import { type Context, fauxAssistantMessage, fauxProvider, type Tool, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

const bash: Tool = {
	name: "bash",
	description: "Run a shell command",
	parameters: Type.Object({ command: Type.String() }),
};
const leak = 'antml:invoke name="bash"><parameter name="command">printf recovered</parameter></invoke>';
const contexts = [
	{
		name: "legacy top-level declaration",
		context: {
			tools: [bash],
			messages: [{ role: "user", content: "Run the command", timestamp: 1 }],
		} satisfies Context,
		recovered: true,
	},
	{
		name: "initial transcript declaration",
		context: {
			messages: [
				{ role: "system", content: "", toolsAdded: [bash], timestamp: 0 },
				{ role: "user", content: "Run the command", timestamp: 1 },
			],
		} satisfies Context,
		recovered: true,
	},
	{
		name: "mid-conversation tool addition",
		context: {
			messages: [
				{ role: "system", content: "", timestamp: 0 },
				{ role: "user", content: "Run the command", timestamp: 1 },
				{ role: "system", content: "", toolsAdded: [bash], timestamp: 2 },
			],
		} satisfies Context,
		recovered: true,
	},
	{
		name: "removed tool stays unavailable",
		context: {
			messages: [
				{ role: "system", content: "", toolsAdded: [bash, { ...bash, name: "other" }], timestamp: 0 },
				{ role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 1 },
				{ role: "user", content: "Run the command", timestamp: 2 },
			],
		} satisfies Context,
		recovered: false,
	},
];

// #3109: the real agent declares tools in system messages, not Context.tools.
// Recovery must use the current transcript declarations, never resurrect removed tools.
describe.each(["stream", "streamSimple"] as const)("ModelRuntime.%s transcript recovery", (method) => {
	it.each(contexts)("$name", async ({ context, recovered }) => {
		const faux = fauxProvider({
			api: "anthropic-messages",
			provider: "transcript-recovery",
			models: [{ id: "mock-claude" }],
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage(leak)]);

		const result = await runtime[method](faux.getModel(), context).result();

		expect(result.stopReason).toBe(recovered ? "toolUse" : "stop");
		expect(result.content).toEqual(
			recovered
				? [{ type: "toolCall", id: "recovered-antml-0", name: "bash", arguments: { command: "printf recovered" } }]
				: [{ type: "text", text: leak }],
		);
		expect(faux.getCallLog()).toHaveLength(1);
	});
});
