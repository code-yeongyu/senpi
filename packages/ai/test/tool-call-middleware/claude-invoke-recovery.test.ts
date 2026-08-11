import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import { createAntmlInvokeRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/antml/recovery-stream.ts";
import type { AssistantMessageEvent, Tool } from "../../src/types.ts";
import { collectEvents, TextStreamHarness, textFrom } from "./invoke-recovery-stream-fixtures.ts";

const taskTool = {
	name: "Task",
	description: "Spawn a child task",
	parameters: Type.Object({
		category: Type.String(),
		name: Type.String(),
		description: Type.String(),
		run_in_background: Type.Boolean(),
		task_summary: Type.String(),
		prompt: Type.String(),
	}),
} satisfies Tool;

function toolEvents(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
	return events.filter((event) => event.type.startsWith("toolcall_"));
}

async function runText(chunks: readonly string[], tools: readonly Tool[] = [taskTool]) {
	const producer = new TextStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, tools);
	producer.start();
	for (const chunk of chunks) {
		producer.delta(chunk);
	}
	producer.finish();
	const events = await collectEvents(wrapped);
	return { events, result: await wrapped.result() };
}

describe("Claude malformed invoke recovery", () => {
	it("recovers transcript-shaped antml task invocation", async () => {
		// Given
		const leakedInvocation = [
			'antml:invoke name="Task">',
			'<parameter name="category">visual-engineering</parameter>',
			'<parameter name="name">w5-monitor</parameter>',
			'<parameter name="description">T25 Monitor activity log section</parameter>',
			'<parameter name="run_in_background">true</parameter>',
			'<parameter name="task_summary">T25 activity log</parameter>',
			'<parameter name="prompt">Add the activity log section.</parameter>',
			"</invoke>",
			"</function_results>",
		].join("\n");

		// When
		const { events, result } = await runText([`Before\n${leakedInvocation}\nAfter`]);

		// Then
		expect(toolEvents(events).map((event) => event.type)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(result.content).toEqual([
			{ type: "text", text: "Before\n" },
			{
				type: "toolCall",
				id: "recovered-antml-0",
				name: "Task",
				arguments: {
					category: "visual-engineering",
					name: "w5-monitor",
					description: "T25 Monitor activity log section",
					run_in_background: true,
					task_summary: "T25 activity log",
					prompt: "Add the activity log section.",
				},
			},
			{ type: "text", text: "\nAfter" },
		]);
		expect(textFrom(result)).not.toContain("antml:invoke");
		expect(textFrom(result)).not.toContain("function_results");
		expect(result.stopReason).toBe("toolUse");
	});

	it("recovers the malformed opening and trailer across stream boundaries", async () => {
		// Given
		const opening = 'antml:invoke name="Task">';
		const body = [
			'<parameter name="category">visual-engineering</parameter>',
			'<parameter name="name">w5-monitor</parameter>',
			'<parameter name="description">T25 Monitor activity log section</parameter>',
			'<parameter name="run_in_background">true</parameter>',
			'<parameter name="task_summary">T25 activity log</parameter>',
			'<parameter name="prompt">Add the activity log section.</parameter>',
			"</invoke>",
		].join("");
		const trailer = "</function_results>";

		for (let split = 0; split <= opening.length; split += 1) {
			// When
			const { events, result } = await runText([opening.slice(0, split), opening.slice(split), body, trailer]);

			// Then
			expect(toolEvents(events), `opening split ${split}`).toHaveLength(3);
			expect(textFrom(result), `opening split ${split}`).toBe("");
		}

		for (let split = 0; split <= trailer.length; split += 1) {
			// When
			const { events, result } = await runText([opening, body, trailer.slice(0, split), trailer.slice(split)]);

			// Then
			expect(toolEvents(events), `trailer split ${split}`).toHaveLength(3);
			expect(textFrom(result), `trailer split ${split}`).toBe("");
		}
	});

	it("keeps code examples and non-exact markers literal", async () => {
		// Given
		const invocation =
			'antml:invoke name="Task"><parameter name="prompt">literal</parameter></invoke></function_results>';
		const inputs = [
			`inline \`${invocation}\` example`,
			`\`\`\`xml\n${invocation}\n\`\`\``,
			`prefix x${invocation}`,
			invocation.replace("antml:invoke", "ANTML:invoke"),
			"</function_results>",
		];

		for (const input of inputs) {
			// When
			const { events, result } = await runText([...input]);

			// Then
			expect(toolEvents(events)).toEqual([]);
			expect(textFrom(result)).toBe(input);
		}
	});

	it("preserves unknown malformed invokes without consuming their trailer", async () => {
		// Given
		const input =
			'antml:invoke name="Missing"><parameter name="prompt">literal</parameter></invoke></function_results>';

		// When
		const { events, result } = await runText([input]);

		// Then
		expect(toolEvents(events)).toEqual([]);
		expect(textFrom(result)).toBe(input);
		expect(result.stopReason).toBe("stop");
	});

	it("recovers adjacent malformed invokes when no stray trailer follows", async () => {
		// Given
		const invocation = (name: string) =>
			[
				'antml:invoke name="Task">',
				'<parameter name="category">quick</parameter>',
				`<parameter name="name">${name}</parameter>`,
				'<parameter name="description">Adjacent task</parameter>',
				'<parameter name="run_in_background">true</parameter>',
				'<parameter name="task_summary">Adjacent task</parameter>',
				'<parameter name="prompt">Run the adjacent task.</parameter>',
				"</invoke>",
			].join("");

		// When
		const { events, result } = await runText([`${invocation("first")}\n${invocation("second")}`]);

		// Then
		expect(toolEvents(events).map((event) => event.type)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
		]);
		expect(result.content.filter((block) => block.type === "toolCall").map((block) => block.arguments.name)).toEqual([
			"first",
			"second",
		]);
		expect(textFrom(result)).toBe("\n");
	});

	it("bounds whitespace retained while probing for a stray trailer", () => {
		// Given
		const parser = createAntmlInvokeRecoveryStreamParser([taskTool]);
		const invocation = [
			'antml:invoke name="Task">',
			'<parameter name="category">quick</parameter>',
			'<parameter name="name">bounded</parameter>',
			'<parameter name="description">Bounded trailer probe</parameter>',
			'<parameter name="run_in_background">true</parameter>',
			'<parameter name="task_summary">Bounded trailer probe</parameter>',
			'<parameter name="prompt">Run the bounded task.</parameter>',
			"</invoke>",
		].join("");
		parser.feed(invocation);

		// When
		const whitespace = " ".repeat(128);
		const events = parser.feed(whitespace);

		// Then
		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.text)
				.join(""),
		).toBe(whitespace);
		expect(events.length).toBeGreaterThan(0);
		expect(parser.finish()).toEqual([]);
	});

	it("recovers a malformed invoke after wrapper text and consumes its trailer", () => {
		// Given
		const parser = createAntmlInvokeRecoveryStreamParser([taskTool]);
		const invocation = [
			'antml:invoke name="Task">',
			'<parameter name="category">quick</parameter>',
			'<parameter name="name">wrapped</parameter>',
			'<parameter name="description">Wrapped malformed call</parameter>',
			'<parameter name="run_in_background">true</parameter>',
			'<parameter name="task_summary">Wrapped malformed call</parameter>',
			'<parameter name="prompt">Run the wrapped task.</parameter>',
			"</invoke>",
		].join("");

		// When
		const events = [
			...parser.feed("<function_calls>prefix "),
			...parser.feed(invocation),
			...parser.feed("</function_results></function_calls>"),
			...parser.finish(),
		];

		// Then
		expect(events.filter((event) => event.type.startsWith("toolcall_"))).toHaveLength(3);
		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.text)
				.join(""),
		).toBe("prefix ");
	});
});
