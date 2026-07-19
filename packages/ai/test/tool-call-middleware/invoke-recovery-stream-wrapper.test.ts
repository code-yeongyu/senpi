import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/index.ts";
import type { AssistantMessageEvent, Tool } from "../../src/types.ts";
import { registerInvokeRecoveryContentExclusionCases } from "./invoke-recovery-content-exclusion-cases.ts";
import { registerInvokeRecoveryContentOrderCases } from "./invoke-recovery-content-order-cases.ts";
import { registerInvokeRecoveryNativeCases } from "./invoke-recovery-native-cases.ts";
import { registerInvokeRecoveryNativeLifecycleCases } from "./invoke-recovery-native-lifecycle-cases.ts";
import {
	collectEvents,
	collectIterator,
	createAssistantMessage,
	nextEvent,
	TextStreamHarness,
	textFrom,
} from "./invoke-recovery-stream-fixtures.ts";

const bashTool = {
	name: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String({ minLength: 3 }) }),
} satisfies Tool;
const rootEntryUrl = new URL("../../src/index.ts", import.meta.url).href;

function toolEvents(events: readonly AssistantMessageEvent[]): AssistantMessageEvent[] {
	return events.filter((event) => event.type.startsWith("toolcall_"));
}

async function runText(chunks: readonly string[], reason: "stop" | "length" = "stop") {
	const producer = new TextStreamHarness();
	const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [bashTool]);
	producer.start();
	for (const chunk of chunks) {
		producer.delta(chunk);
	}
	producer.finish(reason);
	const events = await collectEvents(wrapped);
	return { events, result: await wrapped.result() };
}

describe("wrapStreamWithInvokeRecovery", () => {
	registerInvokeRecoveryContentExclusionCases(bashTool);
	registerInvokeRecoveryContentOrderCases(bashTool);
	registerInvokeRecoveryNativeCases(bashTool);
	registerInvokeRecoveryNativeLifecycleCases(bashTool);

	it("reconstructs text toolCall text and starts before the closing invoke", { timeout: 1000 }, async () => {
		// Given
		const producer = new TextStreamHarness();
		const wrapped = wrapStreamWithInvokeRecovery(producer.inner, [bashTool]);
		const iterator = wrapped[Symbol.asyncIterator]();
		producer.start();
		expect((await nextEvent(iterator)).type).toBe("start");
		expect((await nextEvent(iterator)).type).toBe("text_start");
		producer.delta("Before ");
		expect(await nextEvent(iterator)).toMatchObject({ type: "text_delta", delta: "Before " });

		// When
		const eagerEventPromise = nextEvent(iterator);
		producer.delta('<antml:invoke name="Bash">');
		const eagerEvent = await eagerEventPromise;

		// Then
		expect(eagerEvent).toMatchObject({ type: "toolcall_start", contentIndex: 1 });
		if (eagerEvent.type === "toolcall_start") {
			expect(eagerEvent.partial.content).toEqual([
				{ type: "text", text: "Before " },
				expect.objectContaining({
					type: "toolCall",
					id: "recovered-antml-0",
					name: "Bash",
					arguments: {},
				}),
			]);
		}

		// When
		producer.delta('<antml:parameter name="command">echo ');
		producer.delta("recovered</antml:parameter>");
		producer.delta("</antml:invoke>");
		producer.delta(" after");
		producer.finish();
		const remainingEvents = await collectIterator(iterator);
		const result = await wrapped.result();
		const events = [eagerEvent, ...remainingEvents];

		// Then
		expect(events.map((event) => event.type)).toEqual([
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"text_delta",
			"text_end",
			"done",
		]);
		expect(result.content).toEqual([
			{ type: "text", text: "Before " },
			{
				type: "toolCall",
				id: "recovered-antml-0",
				name: "Bash",
				arguments: { command: "echo recovered" },
			},
			{ type: "text", text: " after" },
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.diagnostics).toEqual([
			{
				type: "text_tool_call_recovery",
				timestamp: expect.any(Number),
				details: {
					protocol: "antml",
					toolName: "Bash",
					id: "recovered-antml-0",
					status: "complete",
				},
			},
		]);
		const diagnosticText = JSON.stringify(result.diagnostics);
		expect(diagnosticText).not.toContain("<antml:invoke");
		expect(diagnosticText).not.toContain("echo recovered");
		expect(diagnosticText).not.toContain("arguments");
		expect(diagnosticText).not.toContain("errorMessage");
	});

	it("recovers bare and namespaced invokes across split chunks", async () => {
		for (const namespace of ["", "antml:"]) {
			const { events, result } = await runText([
				"prefix <",
				`${namespace}invoke name="Bash"`,
				">",
				`<${namespace}parameter name="command">echo split</${namespace}parameter>`,
				`</${namespace}invoke> suffix`,
			]);
			expect(toolEvents(events).map((event) => event.type)).toEqual([
				"toolcall_start",
				"toolcall_delta",
				"toolcall_end",
			]);
			expect(textFrom(result)).toBe("prefix  suffix");
			expect(result.content[1]).toMatchObject({
				type: "toolCall",
				name: "Bash",
				arguments: { command: "echo split" },
			});
		}
	});

	it("keeps active-invoke backticks scannable within the opening delta", async () => {
		const { result } = await runText([
			'<invoke name="Bash"><parameter name="command">echo `pwd`</parameter></invoke>',
		]);

		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "recovered-antml-0",
				name: "Bash",
				arguments: { command: "echo `pwd`" },
			},
		]);
	});

	it("redacts incomplete recovery diagnostics after post-start schema failure", async () => {
		const { result } = await runText(['<invoke name="Bash"><parameter name="command">42</parameter></invoke>']);

		expect(result.content[0]).toMatchObject({ type: "toolCall", arguments: {}, incomplete: true });
		expect(result.diagnostics).toEqual([
			{
				type: "text_tool_call_recovery",
				timestamp: expect.any(Number),
				details: {
					protocol: "antml",
					toolName: "Bash",
					id: "recovered-antml-0",
					status: "incomplete",
				},
			},
		]);
		expect(JSON.stringify(result.diagnostics)).not.toContain("failed validation");
	});

	it("passes text-only unknown-tool and malformed-before-start streams unchanged", async () => {
		const inputs = [
			"ordinary text only",
			'before <invoke name="Missing"><parameter name="x">1</parameter></invoke> after',
			'before <invoke name=Bash><parameter name="command">echo nope</parameter></invoke> after',
		];
		for (const input of inputs) {
			const { events, result } = await runText([input], "length");
			expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
			expect(result).toEqual(createAssistantMessage([{ type: "text", text: input }], "length"));
			expect(toolEvents(events)).toEqual([]);
			expect(result.diagnostics).toBeUndefined();
		}
	});

	it("keeps code examples literal and interrupts partial candidates at mask boundaries", async () => {
		const invoke = '<invoke name="Bash"><parameter name="command">echo example</parameter></invoke>';
		const input = `before <inv\`masked\`oke name="Bash">\ninline \`${invoke}\`\n\`\`\`xml\n${invoke}\n\`\`\` after`;
		const { events, result } = await runText([...input]);

		expect(textFrom(result)).toBe(input);
		expect(toolEvents(events)).toEqual([]);
		expect(result.diagnostics).toBeUndefined();
	});

	it("exports the wrapper from the side-effect-free root without compat imports", () => {
		const script = `
			import { registerHooks } from "node:module";
			const globals = new Set(Object.getOwnPropertyNames(globalThis));
			const compatImports = [];
			registerHooks({ resolve(specifier, context, nextResolve) {
				if (specifier === "./compat.ts" || specifier.endsWith("/compat.ts")) compatImports.push(specifier);
				return nextResolve(specifier, context);
			} });
			const root = await import(${JSON.stringify(rootEntryUrl)});
			console.log(JSON.stringify({
				wrapperType: typeof root.wrapStreamWithInvokeRecovery,
				compatImports,
				addedGlobals: Object.getOwnPropertyNames(globalThis).filter((key) => !globals.has(key)),
			}));
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });

		expect(result.status).toBe(0);
		const output: unknown = JSON.parse(result.stdout);
		expect(output).toEqual({ wrapperType: "function", compatImports: [], addedGlobals: [] });
	});
});
