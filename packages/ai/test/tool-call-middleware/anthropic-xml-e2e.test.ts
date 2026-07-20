import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "../../src/providers/faux.ts";
import { stream } from "../../src/stream.ts";
import {
	getProtocol,
	getToolCallFormat,
	wrapStreamWithToolCallMiddleware,
} from "../../src/tool-call-middleware/index.ts";
import type { AssistantMessage, AssistantMessageEvent, Model, Tool } from "../../src/types.ts";

const bashTool: Tool = {
	name: "Bash",
	description: "Run a shell command",
	parameters: Type.Object({ command: Type.String() }),
};

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];
type ToolCallEndEvent = Extract<AssistantMessageEvent, { type: "toolcall_end" }>;
type E2eResult = { events: AssistantMessageEvent[]; result: AssistantMessage };

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function createModel(faux: ReturnType<typeof registerFauxProvider>): Model<"openai-completions"> {
	return {
		...faux.getModel(),
		api: "openai-completions",
		compat: { toolCallFormat: "anthropic-xml" },
	} satisfies Model<"openai-completions">;
}

function createFauxStream(
	faux: ReturnType<typeof registerFauxProvider>,
	text: string,
	model: Model<"openai-completions">,
): ReturnType<typeof stream> {
	faux.setResponses([fauxAssistantMessage(text, { stopReason: "stop" })]);
	return stream(model, { messages: [{ role: "user", content: "Run it", timestamp: 0 }] });
}

async function collectEvents(streamToCollect: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamToCollect) {
		events.push(event);
	}
	return events;
}

function textDeltas(events: readonly AssistantMessageEvent[]): string {
	return events
		.filter((event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta")
		.map((event) => event.delta)
		.join("");
}

function toolCallEnds(events: readonly AssistantMessageEvent[]): ToolCallEndEvent[] {
	return events.filter((event): event is ToolCallEndEvent => event.type === "toolcall_end");
}

function expectToolCallLifecycle(events: readonly AssistantMessageEvent[]): void {
	const types = events.map((event) => event.type);
	const start = types.indexOf("toolcall_start");
	const delta = types.indexOf("toolcall_delta");
	const end = types.indexOf("toolcall_end");

	expect(types[0]).toBe("start");
	expect(start).toBeGreaterThanOrEqual(0);
	expect(delta).toBeGreaterThan(start);
	expect(end).toBeGreaterThan(delta);
}

async function runFauxResponse(text: string): Promise<E2eResult> {
	const faux = registerFauxProvider({
		api: "openai-completions",
		tokenSize: { min: 1, max: 1 },
		schedulerHook: () => undefined,
	});
	registrations.push(faux);
	const model = createModel(faux);
	const format = getToolCallFormat(model);
	if (format === undefined) {
		throw new Error("Expected anthropic-xml compatibility format");
	}

	const innerStream = createFauxStream(faux, text, model);
	const wrappedStream = wrapStreamWithToolCallMiddleware(innerStream, getProtocol(format), [bashTool]);
	const events = await collectEvents(wrappedStream);
	return { events, result: await wrappedStream.result() };
}

describe("anthropic-xml faux-provider e2e", () => {
	it("catches the user's Bash invoke as canonical tool-call events", async () => {
		// Given
		const response =
			'Let me run it.\n<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>\nDone.';

		// When
		const run = await runFauxResponse(response);

		// Then
		expectToolCallLifecycle(run.events);
		const [toolCall] = toolCallEnds(run.events);
		if (toolCall === undefined) {
			throw new Error("Expected one Bash tool call");
		}
		expect(toolCall.toolCall).toMatchObject({
			name: "Bash",
			arguments: { command: "echo hi" },
		});
		expect(textDeltas(run.events)).toBe("Let me run it.\n\nDone.");
		expect(run.result.content).toEqual([
			{ type: "text", text: "Let me run it.\n" },
			{ type: "toolCall", id: "anthropic-xml-tool-0", name: "Bash", arguments: { command: "echo hi" } },
			{ type: "text", text: "\nDone." },
		]);
		expect(run.result.stopReason).toBe("toolUse");
	});

	it("preserves prose and catches two Bash invokes in one faux response", async () => {
		// Given
		const response =
			'First.\n<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>\nSecond.\n' +
			'<invoke name="Bash"><parameter name="command">echo bye</parameter></invoke>\nFinished.';

		// When
		const run = await runFauxResponse(response);

		// Then
		const toolCalls = toolCallEnds(run.events);
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls.map((event) => event.toolCall.arguments.command)).toEqual(["echo hi", "echo bye"]);
		expect(textDeltas(run.events)).toBe("First.\n\nSecond.\n\nFinished.");
		expect(run.result.stopReason).toBe("toolUse");
		expect(run.result.content).toHaveLength(5);
	});

	it("accepts the optional function_calls wrapper without emitting wrapper text", async () => {
		// Given
		const response =
			'<function_calls><invoke name="Bash"><parameter name="command">echo hi</parameter></invoke></function_calls>';

		// When
		const run = await runFauxResponse(response);

		// Then
		expect(toolCallEnds(run.events)).toHaveLength(1);
		expect(textDeltas(run.events)).toBe("");
		expect(run.result.content).toEqual([
			{ type: "toolCall", id: "anthropic-xml-tool-0", name: "Bash", arguments: { command: "echo hi" } },
		]);
	});
});
