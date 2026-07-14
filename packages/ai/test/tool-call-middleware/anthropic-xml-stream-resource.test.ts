import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	createAnthropicXmlStreamParser,
} from "../../src/tool-call-middleware/protocols/anthropic-xml/stream.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const scanWork = vi.hoisted(() => ({ calls: 0, codeUnits: 0 }));

vi.mock("../../src/tool-call-middleware/protocols/anthropic-xml/invoke-tag-scanner.ts", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../src/tool-call-middleware/protocols/anthropic-xml/invoke-tag-scanner.ts")
		>();
	const scanInvokeBlock = (...parameters: Parameters<typeof actual.scanInvokeBlock>) => {
		scanWork.calls += 1;
		scanWork.codeUnits += parameters[0].length;
		return actual.scanInvokeBlock(...parameters);
	};
	return { ...actual, scanInvokeBlock };
});

const EXPECTED_OVERFLOW_MESSAGE = `Anthropic XML streaming fragment exceeded the ${ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH}-character retained-input limit.`;

const bashTool = {
	name: "Bash",
	description: "Run a shell command",
	parameters: Type.Object({
		command: Type.String(),
	}),
} satisfies Tool;

const recoveryCall = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';

function createBoundaryHeavyCall(targetLength: number): { readonly command: string; readonly input: string } {
	const prefix = '<invoke name="Bash"><parameter name="command">';
	const suffix = "</parameter></invoke>";
	const commandLength = targetLength - prefix.length - suffix.length;
	const nestedPairLength = prefix.length + suffix.length;
	const candidateCount = Math.floor(commandLength / nestedPairLength);
	const command =
		prefix.repeat(candidateCount) +
		"x".repeat(commandLength - candidateCount * nestedPairLength) +
		suffix.repeat(candidateCount);
	return { command, input: prefix + command + suffix };
}

function textOutput(events: StreamParserEvent[]): string {
	return events
		.filter((event): event is Extract<StreamParserEvent, { type: "text" }> => event.type === "text")
		.map((event) => event.text)
		.join("");
}

function toolCallEnds(events: StreamParserEvent[]): Extract<StreamParserEvent, { type: "toolcall_end" }>[] {
	return events.filter(
		(event): event is Extract<StreamParserEvent, { type: "toolcall_end" }> => event.type === "toolcall_end",
	);
}

beforeEach(() => {
	scanWork.calls = 0;
	scanWork.codeUnits = 0;
});

it("keeps nested candidate-close processing linear in one-character streams", () => {
	// given
	const { command, input } = createBoundaryHeavyCall(24 * 1024);
	const parser = createAnthropicXmlStreamParser([bashTool]);
	const events: StreamParserEvent[] = [];

	// when
	const startedAt = performance.now();
	for (const character of input) {
		events.push(...parser.feed(character));
	}
	events.push(...parser.finish());
	const elapsedMs = performance.now() - startedAt;

	// then
	expect(elapsedMs).toBeLessThan(10_000);
	expect(scanWork.calls, `scan work: ${JSON.stringify(scanWork)}`).toBe(2);
	expect(scanWork.codeUnits, `scan work: ${JSON.stringify(scanWork)}`).toBeLessThanOrEqual(input.length + 128);
	expect(toolCallEnds(events).map((event) => event.arguments.command)).toEqual([command]);
});

describe.each([
	{
		kind: "invoke",
		prefix: '<invoke name="Bash"><parameter name="command">',
	},
	{
		kind: "function_calls wrapper",
		prefix: "<function_calls>",
	},
])("createAnthropicXmlStreamParser resource bounds for an incomplete $kind", ({ prefix }) => {
	it.each([
		{ emitRaw: false, expectedRawText: "" },
		{ emitRaw: true, expectedRawText: "input" },
	])("bounds one-byte deltas and recovers after overflow (raw: $emitRaw)", ({ emitRaw, expectedRawText }) => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([bashTool], {
			emitRawToolCallTextOnError: emitRaw,
			onError,
		});
		const input = prefix + "x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - prefix.length);
		const overflowEvents: StreamParserEvent[] = [];

		// when
		const startedAt = performance.now();
		for (const character of input) {
			overflowEvents.push(...parser.feed(character));
		}
		const elapsedMs = performance.now() - startedAt;
		const recoveryEvents = [...parser.feed(recoveryCall), ...parser.finish()];

		// then
		expect(elapsedMs).toBeLessThan(5_000);
		expect(onError).toHaveBeenCalledOnce();
		const [message, metadata] = onError.mock.calls[0] ?? [];
		expect(message).toBe(EXPECTED_OVERFLOW_MESSAGE);
		expect(metadata).toEqual({ toolCall: input });
		expect(textOutput(overflowEvents)).toBe(expectedRawText === "input" ? input : expectedRawText);
		expect(toolCallEnds(recoveryEvents)).toEqual([
			{
				type: "toolcall_end",
				index: 0,
				name: "Bash",
				id: "anthropic-xml-tool-0",
				arguments: { command: "echo recovered" },
			},
		]);
		expect(textOutput(recoveryEvents)).toBe("");
	});
});
