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

it("keeps recovery scan work linear for one-character deltas", () => {
	// Given
	const command = "x".repeat(16 * 1024);
	const input = `<invoke name="Bash"><parameter name="command">${command}</parameter></invoke>`;
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);
	const events: StreamParserEvent[] = [];

	// When
	for (const character of input) {
		events.push(...parser.feed(character));
	}
	events.push(...parser.finish());

	// Then
	expect(scanWork.calls, `scan work: ${JSON.stringify(scanWork)}`).toBe(1);
	expect(scanWork.codeUnits, `scan work: ${JSON.stringify(scanWork)}`).toBeLessThanOrEqual(input.length);
	expect(toolCallEnds(events)).toEqual([expect.objectContaining({ arguments: { command } })]);
});

it("bounds a partial opening tag before toolcall_start and recovers", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const input = `<invoke name="${"x".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - '<invoke name="'.length)}`;
	const events: StreamParserEvent[] = [];

	// When
	for (const character of input) {
		events.push(...parser.feed(character));
	}
	const recoveryEvents = [...parser.feed(validCall), ...parser.finish()];

	// Then
	expect(textOutput(events)).toBe(input);
	expect(events.filter((event) => event.type === "toolcall_start")).toEqual([]);
	expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
		protocol: "antml",
		retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	});
	expect(toolCallEnds(recoveryEvents)).toEqual([
		expect.objectContaining({ id: "recovered-antml-0", arguments: { command: "echo recovered" } }),
	]);
});

it("does not double count an unknown-only wrapper fragment", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const wrapper = "<function_calls>";
	const fragment = `<${"x".repeat(32_759)}<`;
	const input = `${wrapper}${fragment}`;

	// When
	const events = [...feedUnits(parser, input), ...parser.finish()];

	// Then
	expect(input.length).toBe(32_777);
	expect(textOutput(events)).toBe(input);
	expect(onError).not.toHaveBeenCalled();
	expect(wrapperWork.maxRetained, `wrapper work: ${JSON.stringify(wrapperWork)}`).toBeLessThanOrEqual(input.length);
});

it("preserves unknown-only wrapper text across fragment overflow", () => {
	// Given
	const onError = vi.fn();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool], { onError });
	const wrapper = "<function_calls>";
	const fragment = `<${"x".repeat(32_759)}<`;
	const trailing = `${"y".repeat(ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH - wrapper.length - fragment.length)}😀</function_calls>`;
	const input = `${wrapper}${fragment}${trailing}`;

	// When
	const events = feedUnits(parser, input);
	const recoveryEvents = [...parser.feed(validCall), ...parser.finish()];

	// Then
	expect(textOutput(events)).toBe(input);
	expect(onError).toHaveBeenCalledTimes(1);
	expect(onError).toHaveBeenCalledWith("ANTML recovery fragment exceeded the retained-input limit.", {
		protocol: "antml",
		retainedLength: ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	});
	expect(JSON.stringify(onError.mock.calls)).not.toContain(fragment);
	expect(wrapperWork.maxRetained, `wrapper work: ${JSON.stringify(wrapperWork)}`).toBe(
		ANTHROPIC_XML_MAX_RETAINED_FRAGMENT_LENGTH,
	);
	expect(toolCallEnds(recoveryEvents)).toEqual([
		expect.objectContaining({ id: "recovered-antml-0", arguments: { command: "echo recovered" } }),
	]);
});
