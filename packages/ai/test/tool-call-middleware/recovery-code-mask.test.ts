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
			if (segment.scan) {
				events.push(...parser.feed(segment.text));
			}
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
});
