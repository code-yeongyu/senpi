import { Type } from "typebox";
import { beforeEach, expect, it, vi } from "vitest";
import { ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH } from "../../src/tool-call-middleware/protocols/anthropic-xml/stream-boundary.ts";
import { createAntmlInvokeRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/antml/recovery-stream.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const scanWork = vi.hoisted(() => ({ calls: 0, codeUnits: 0 }));
const wrapperWork = vi.hoisted(() => ({ calls: 0, maxRetained: 0 }));

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

vi.mock("../../src/tool-call-middleware/protocols/anthropic-xml/recovery-wrapper-state.ts", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../src/tool-call-middleware/protocols/anthropic-xml/recovery-wrapper-state.ts")
		>();
	class InstrumentedRecoveryWrapperState extends actual.RecoveryWrapperState {
		private observed = "";

		override feed(character: string) {
			this.observed += character;
			const actions = super.feed(character);
			const state = this as unknown as { opening: string; recovered: boolean; tag: string };
			wrapperWork.calls += 1;
			wrapperWork.maxRetained = Math.max(
				wrapperWork.maxRetained,
				state.recovered ? state.tag.length : state.opening.length + this.observed.length,
			);
			return actions;
		}
	}
	return { ...actual, RecoveryWrapperState: InstrumentedRecoveryWrapperState };
});

const bashTool = {
	name: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String() }),
} satisfies Tool;

const validCall = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';

function textOutput(events: readonly StreamParserEvent[]): string {
	return events
		.filter((event): event is Extract<StreamParserEvent, { type: "text" }> => event.type === "text")
		.map((event) => event.text)
		.join("");
}

function toolCallEnds(events: readonly StreamParserEvent[]): Extract<StreamParserEvent, { type: "toolcall_end" }>[] {
	return events.filter(
		(event): event is Extract<StreamParserEvent, { type: "toolcall_end" }> => event.type === "toolcall_end",
	);
}

function feedUnits(
	parser: ReturnType<typeof createAntmlInvokeRecoveryStreamParser>,
	input: string,
): StreamParserEvent[] {
	const events: StreamParserEvent[] = [];
	for (const unit of input) {
		events.push(...parser.feed(unit));
	}
	return events;
}

beforeEach(() => {
	scanWork.calls = 0;
	scanWork.codeUnits = 0;
	wrapperWork.calls = 0;
	wrapperWork.maxRetained = 0;
});

it("bounds UTF-16 surrogate crossings before recovery start", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const openingPrefix = '<invoke name="';
	const prefix = `${openingPrefix}${"x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - 1 - openingPrefix.length)}`;

	// When
	const events = [...feedUnits(parser, prefix), ...feedUnits(parser, "😀")];
	const recoveryEvents = [...parser.feed(validCall), ...parser.finish()];

	// Then
	expect(textOutput(events)).toBe(`${prefix}😀`);
	expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
		protocol: "antml",
		retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - 1,
	});
	expect(JSON.stringify(onError.mock.calls)).not.toContain(prefix);
	expect(toolCallEnds(recoveryEvents)).toEqual([
		expect.objectContaining({ id: "recovered-antml-0", arguments: { command: "echo recovered" } }),
	]);
});

it("bounds UTF-16 surrogate crossings during an active recovery", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const opening = '<invoke name="Bash">';
	const activePrefix = "x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - opening.length - 1);

	// When
	parser.feed(opening);
	feedUnits(parser, activePrefix);
	const crossingEvents = feedUnits(parser, "😀");
	const recoveryEvents = [...parser.feed(validCall), ...parser.finish()];

	// Then
	expect(textOutput(crossingEvents)).toBe("😀");
	expect(toolCallEnds(crossingEvents)).toEqual([
		expect.objectContaining({ incomplete: true, errorMessage: "Tool call stream ended before completion" }),
	]);
	expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
		protocol: "antml",
		retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - 1,
	});
	expect(toolCallEnds(recoveryEvents)).toEqual([
		expect.objectContaining({ id: "recovered-antml-1", arguments: { command: "echo recovered" } }),
	]);
});

it("bounds UTF-16 surrogate crossings after a recovered wrapper call", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const knownWrapperCall = '<function_calls><invoke name="Bash"><parameter name="command">one</parameter></invoke>';
	const prefix = `<${"x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - 2)}`;

	// When
	parser.feed(knownWrapperCall);
	const crossingEvents = [...feedUnits(parser, prefix), ...feedUnits(parser, "😀")];
	const closeEvents = parser.feed("</function_calls>");
	const recoveryEvents = [...parser.feed(validCall), ...parser.finish()];

	// Then
	expect(textOutput(crossingEvents)).toBe(`${prefix}😀`);
	expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
		protocol: "antml",
		retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - 1,
	});
	expect(JSON.stringify(onError.mock.calls)).not.toContain(prefix);
	expect(textOutput(closeEvents)).toBe("");
	expect(toolCallEnds(recoveryEvents)).toEqual([
		expect.objectContaining({ id: "recovered-antml-1", arguments: { command: "echo recovered" } }),
	]);
	expect(wrapperWork.maxRetained, `wrapper work: ${JSON.stringify(wrapperWork)}`).toBeLessThanOrEqual(
		ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	);
});

it("bounds partial tags after a recovered wrapper call", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const knownWrapperCall = '<function_calls><invoke name="Bash"><parameter name="command">one</parameter></invoke>';
	const partialTag = `<${"x".repeat(66_560)}`;
	const partialEvents: StreamParserEvent[] = [];

	// When
	parser.feed(knownWrapperCall);
	for (const character of partialTag) {
		partialEvents.push(...parser.feed(character));
	}
	const closeEvents = parser.feed("</function_calls>");
	const recoveryEvents = [...parser.feed(validCall), ...parser.finish()];

	// Then
	expect(textOutput(partialEvents)).toBe(partialTag);
	expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
		protocol: "antml",
		retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	});
	expect(JSON.stringify(onError.mock.calls)).not.toContain(partialTag);
	expect(textOutput(closeEvents)).toBe("");
	expect(toolCallEnds(recoveryEvents)).toEqual([
		expect.objectContaining({ id: "recovered-antml-1", arguments: { command: "echo recovered" } }),
	]);
	expect(wrapperWork.maxRetained, `wrapper work: ${JSON.stringify(wrapperWork)}`).toBeLessThanOrEqual(
		ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	);
	expect(wrapperWork.calls).toBeLessThanOrEqual(partialTag.length + knownWrapperCall.length + validCall.length + 32);
});

it("finalizes an active call incomplete on retained-buffer overflow and recovers", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const opening = '<invoke name="Bash">';
	const input = opening + "x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - opening.length);
	const events: StreamParserEvent[] = [];

	// When
	for (const character of input) {
		events.push(...parser.feed(character));
	}
	const recoveryEvents = [...parser.feed(validCall), ...parser.finish()];

	// Then
	expect(toolCallEnds(events)).toEqual([
		expect.objectContaining({
			id: "recovered-antml-0",
			incomplete: true,
			errorMessage: "Tool call stream ended before completion",
		}),
	]);
	expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
		protocol: "antml",
		retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	});
	expect(toolCallEnds(recoveryEvents)).toEqual([
		expect.objectContaining({ id: "recovered-antml-1", arguments: { command: "echo recovered" } }),
	]);
});
