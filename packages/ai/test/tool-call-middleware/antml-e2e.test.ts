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

const editTool: Tool = {
	name: "Edit",
	description: "Edit a file",
	parameters: Type.Object({
		file_path: Type.String(),
		edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
	}),
};

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];
type ToolCallEndEvent = Extract<AssistantMessageEvent, { type: "toolcall_end" }>;

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

async function runFauxResponse(text: string): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const faux = registerFauxProvider({
		api: "openai-completions",
		tokenSize: { min: 1, max: 1 },
		schedulerHook: () => undefined,
	});
	registrations.push(faux);
	const model = {
		...faux.getModel(),
		api: "openai-completions",
		compat: { toolCallFormat: "antml" },
	} satisfies Model<"openai-completions">;
	const format = getToolCallFormat(model);
	if (format === undefined) {
		throw new Error("Expected antml compatibility format");
	}

	faux.setResponses([fauxAssistantMessage(text, { stopReason: "stop" })]);
	const innerStream = stream(model, { messages: [{ role: "user", content: "Edit it", timestamp: 0 }] });
	const wrappedStream = wrapStreamWithToolCallMiddleware(innerStream, getProtocol(format), [editTool]);
	const events: AssistantMessageEvent[] = [];
	for await (const event of wrappedStream) {
		events.push(event);
	}
	return { events, result: await wrappedStream.result() };
}

function toolCallEnds(events: readonly AssistantMessageEvent[]): ToolCallEndEvent[] {
	return events.filter((event): event is ToolCallEndEvent => event.type === "toolcall_end");
}

describe("antml faux-provider e2e", () => {
	it("executes a slop-laden wrapped Edit call with repaired canonical arguments", async () => {
		// given: invented keys and an aliased path, exactly the Opus 4.8 failure mode
		const response =
			"Fixing the file now.\n" +
			"<function_calls>\n" +
			'<invoke name="Edit">\n' +
			'<parameter name="path">some/file.py</parameter>\n' +
			'<parameter name="edits">[{"oldText":"before","newText":"after","requireUnique":true,"type":"edit"}]</parameter>\n' +
			"</invoke>\n" +
			"</function_calls>\n" +
			"Done.";

		// when
		const run = await runFauxResponse(response);

		// then
		const [toolCall] = toolCallEnds(run.events);
		if (toolCall === undefined) {
			throw new Error("Expected one Edit tool call");
		}
		expect(toolCall.toolCall).toMatchObject({
			name: "Edit",
			arguments: {
				file_path: "some/file.py",
				edits: [{ oldText: "before", newText: "after" }],
			},
		});
		expect(run.result.stopReason).toBe("toolUse");
		expect(run.result.content).toEqual([
			{ type: "text", text: "Fixing the file now.\n\n" },
			{
				type: "toolCall",
				id: "antml-tool-0",
				name: "Edit",
				arguments: { file_path: "some/file.py", edits: [{ oldText: "before", newText: "after" }] },
			},
			{ type: "text", text: "\n\nDone." },
		]);
	});
});
