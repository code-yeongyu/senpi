import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAntmlInvokeRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/antml/recovery-stream.ts";
import { createRecoveryCodeMask } from "../../src/tool-call-middleware/recovery-code-mask.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const bashTool = {
	name: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String({ minLength: 3 }) }),
} satisfies Tool;

const codeInvoke = '<invoke name="Bash"><parameter name="command">echo example</parameter></invoke>';
const executableInvoke = '<invoke name="Bash"><parameter name="command">echo executable</parameter></invoke>';

type MaskRun = {
	readonly text: string;
	readonly events: readonly StreamParserEvent[];
};

function allMeaningfulChunkSplits(text: string): readonly (readonly string[])[] {
	const splits: string[][] = [[text], [...text]];
	for (let index = 1; index < text.length; index += 1) {
		splits.push([text.slice(0, index), text.slice(index)]);
	}
	return splits;
}

function runMask(chunks: readonly string[]): MaskRun {
	const mask = createRecoveryCodeMask();
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);
	const events: StreamParserEvent[] = [];
	let text = "";

	for (const chunk of chunks) {
		for (const segment of mask.feed(chunk)) {
			text += segment.text;
			if (segment.recoveryBoundary) {
				events.push(...parser.interrupt());
			}
			if (segment.scan) {
				events.push(...parser.feed(segment.text));
			}
		}
	}
	for (const segment of mask.finish()) {
		text += segment.text;
		if (segment.recoveryBoundary) {
			events.push(...parser.interrupt());
		}
		if (segment.scan) {
			events.push(...parser.feed(segment.text));
		}
	}
	events.push(...parser.finish());
	return { text, events };
}

function recoveredCommands(events: readonly StreamParserEvent[]): unknown[] {
	return events
		.filter((event): event is Extract<StreamParserEvent, { type: "toolcall_end" }> => event.type === "toolcall_end")
		.map((event) => event.arguments.command);
}

function expectAcrossEverySplit(input: string, expectedCommands: readonly string[]): void {
	for (const [index, chunks] of allMeaningfulChunkSplits(input).entries()) {
		const result = runMask(chunks);
		expect(result.text, `split ${index} must preserve output`).toBe(input);
		expect(recoveredCommands(result.events), `split ${index} must recover only executable invokes`).toEqual(
			expectedCommands,
		);
	}
}

describe("recovery code masking", () => {
	it("suppresses invoke-like examples inside code while preserving later executable calls", () => {
		const input = `Example: \`${codeInvoke}\`\nThen run ${executableInvoke}`;

		expectAcrossEverySplit(input, ["echo executable"]);
	});

	it("masks inline and fenced invoke examples across split backtick runs", () => {
		const inlineWithMatchingDelimiter = `Inline: \`\`${codeInvoke}\`\` then ${executableInvoke}`;
		const inlineNewlineReset = `Unclosed: \`${codeInvoke}\nThen ${executableInvoke}`;
		const mismatchedInlineClose = `Inline: \`\`${codeInvoke}\` still code\nThen ${executableInvoke}`;
		const indentedFourBacktickFence = `   \`\`\`\`xml\n${codeInvoke}\n\`\`\`\n${codeInvoke}\n   \`\`\`\`\nThen ${executableInvoke}`;

		expectAcrossEverySplit(inlineWithMatchingDelimiter, ["echo executable"]);
		expectAcrossEverySplit(inlineNewlineReset, ["echo executable"]);
		expectAcrossEverySplit(mismatchedInlineClose, ["echo executable"]);
		expectAcrossEverySplit(indentedFourBacktickFence, ["echo executable"]);
		for (const indent of ["", " ", "  ", "   "]) {
			expectAcrossEverySplit(`${indent}\`\`\`xml\n${codeInvoke}\n${indent}\`\`\`\nThen ${executableInvoke}`, [
				"echo executable",
			]);
		}
	});

	it("preserves ordinary text and active-call backticks across every split point", () => {
		const activeCall = '<invoke name="Bash"><parameter name="command">echo ```literal```</parameter></invoke>';
		for (const [index, chunks] of allMeaningfulChunkSplits(activeCall).entries()) {
			const mask = createRecoveryCodeMask();
			const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);
			const events = chunks.flatMap((chunk) =>
				mask.feed(chunk, { activeInvoke: true }).flatMap((segment) => parser.feed(segment.text)),
			);
			events.push(...parser.finish());
			expect(recoveredCommands(events), `active split ${index}`).toEqual(["echo ```literal```"]);
		}
	});

	it("preserves ordinary prose and invokes split across every boundary", () => {
		const input = `ordinary prose before ${executableInvoke} ordinary prose after`;

		expectAcrossEverySplit(input, ["echo executable"]);
	});

	it("masked spans break partial recovery candidates", () => {
		const bridgedInvoke = '<inv`masked`oke name="Bash"><parameter name="command">echo bridged</parameter></invoke>';
		const mask = createRecoveryCodeMask();
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);
		const events: StreamParserEvent[] = [];
		const chunks = [
			"emoji 😀 <inv",
			"",
			"`masked`oke",
			bridgedInvoke.slice("<inv`masked`oke".length),
			`\n${executableInvoke}`,
		];
		let output = "";

		for (const chunk of chunks) {
			for (const segment of mask.feed(chunk)) {
				output += segment.text;
				if (segment.recoveryBoundary) {
					events.push(...parser.interrupt());
				}
				if (segment.scan) {
					events.push(...parser.feed(segment.text));
				}
			}
		}
		for (const segment of mask.finish()) {
			output += segment.text;
			if (segment.scan) {
				events.push(...parser.feed(segment.text));
			}
		}
		events.push(...parser.finish());

		expect(output).toBe(chunks.join(""));
		expect(recoveredCommands(events)).toEqual(["echo executable"]);
	});

	it("accepts a longer matching fence closer", () => {
		const input = `\`\`\`xml\n${codeInvoke}\n\`\`\`\`\n${executableInvoke}`;

		expectAcrossEverySplit(input, ["echo executable"]);
	});

	it("resets an unclosed inline span on CR-only newline", () => {
		for (const newline of ["\r", "\r\n"]) {
			expectAcrossEverySplit(`😀 \`${codeInvoke}${newline}${executableInvoke}`, ["echo executable"]);
		}
	});

	it("preserves order and line state through active invoke bypass", () => {
		const mask = createRecoveryCodeMask();
		const ordered = [
			...mask.feed("`"),
			...mask.feed("", { activeInvoke: true }),
			...mask.feed("ABC😀\r", { activeInvoke: true }),
			...mask.finish(),
		];
		expect(ordered.map((segment) => segment.text).join("")).toBe("`ABC😀\r");

		const lineStateMask = createRecoveryCodeMask();
		const input = `x\r\`\`\`xml\n${codeInvoke}\n\`\`\`\n${executableInvoke}`;
		const result = runMaskWithActivePrefix(lineStateMask, input);
		expect(result.text).toBe(input);
		expect(recoveredCommands(result.events)).toEqual(["echo executable"]);
	});

	it("bounds arbitrarily long backtick runs", () => {
		const ticks = "`".repeat(1_000_000);
		const mask = createRecoveryCodeMask();
		const duringFeed = [...mask.feed(ticks.slice(0, 500_000)), ...mask.feed(""), ...mask.feed(ticks.slice(500_000))];
		const atFinish = mask.finish();

		expect(duringFeed.map((segment) => segment.text).join("")).toBe(ticks);
		expect(duringFeed.every((segment) => !segment.scan)).toBe(true);
		expect(atFinish).toEqual([]);
	});

	it("rejects feed after finish", () => {
		const mask = createRecoveryCodeMask();
		mask.finish();

		expect(mask.finish()).toEqual([]);
		expect(() => mask.feed("later")).toThrow("Recovery code mask is finished");
	});

	it("preserves split surrogate pairs across repeated fresh masks", () => {
		const input = "```xml meta=😀\nX\n```\nY";
		for (let iteration = 0; iteration < 200; iteration += 1) {
			expect(maskOutput([input.slice(0, 13), "", input.slice(13)])).toBe(input);
		}
	});

	it("preserves emoji across every UTF-16 split around code boundaries", () => {
		const cases = [
			{ input: "```xml meta=😀\nX\n```\nY", activeInvoke: false },
			{ input: "😀`😀`😀", activeInvoke: false },
			{ input: "```😀\r\n😀\n```\r😀", activeInvoke: false },
			{ input: "ordinary `😀 ordinary 😀` text", activeInvoke: false },
			{ input: "😀```😀\r\n😀```\r\n😀", activeInvoke: true },
		] as const;
		for (const { input, activeInvoke } of cases) {
			for (let split = 0; split <= input.length; split += 1) {
				expect(maskOutput([input.slice(0, split), "", input.slice(split)], activeInvoke)).toBe(input);
			}
		}
	});
});

function maskOutput(chunks: readonly string[], activeInvoke = false): string {
	const mask = createRecoveryCodeMask();
	return [
		...chunks.flatMap((chunk) => mask.feed(chunk, activeInvoke ? { activeInvoke: true } : undefined)),
		...mask.finish(),
	]
		.map((segment) => segment.text)
		.join("");
}

function runMaskWithActivePrefix(mask: ReturnType<typeof createRecoveryCodeMask>, input: string): MaskRun {
	const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);
	const events: StreamParserEvent[] = [];
	let text = "";
	for (const segment of mask.feed("x")) {
		text += segment.text;
		if (segment.scan) {
			events.push(...parser.feed(segment.text));
		}
	}
	for (const segment of mask.feed("\r", { activeInvoke: true })) {
		text += segment.text;
		if (segment.scan) {
			events.push(...parser.feed(segment.text));
		}
	}
	for (const segment of mask.feed(input.slice(2))) {
		text += segment.text;
		if (segment.scan) {
			events.push(...parser.feed(segment.text));
		}
	}
	for (const segment of mask.finish()) {
		text += segment.text;
		if (segment.scan) {
			events.push(...parser.feed(segment.text));
		}
	}
	events.push(...parser.finish());
	return { text, events };
}
