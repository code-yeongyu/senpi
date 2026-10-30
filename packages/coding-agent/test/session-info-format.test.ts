import { describe, expect, it, vi } from "vitest";
import { formatSessionInfo } from "../src/modes/interactive/session-info-format.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("../src/modes/interactive/theme/theme.js", () => ({
	theme: {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	},
}));

interface BuildArgs {
	cost?: number;
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
	sessionFile?: string | undefined;
	messages?: {
		user?: number;
		assistant?: number;
		toolCalls?: number;
		toolResults?: number;
	};
}

function buildStats(args: BuildArgs = {}) {
	const tokensIn = args.tokens?.input ?? 100;
	const tokensOut = args.tokens?.output ?? 200;
	const cacheRead = args.tokens?.cacheRead ?? 0;
	const cacheWrite = args.tokens?.cacheWrite ?? 0;
	const userMessages = args.messages?.user ?? 1;
	const assistantMessages = args.messages?.assistant ?? 1;
	const toolCalls = args.messages?.toolCalls ?? 0;
	const toolResults = args.messages?.toolResults ?? 0;

	return {
		sessionFile: args.sessionFile ?? "/tmp/session.jsonl",
		sessionId: "session-abc-123",
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: userMessages + assistantMessages + toolResults,
		tokens: {
			input: tokensIn,
			output: tokensOut,
			cacheRead,
			cacheWrite,
			total: tokensIn + tokensOut + cacheRead + cacheWrite,
		},
		cost: args.cost ?? 0,
		contextUsage: args.contextUsage,
	};
}

describe("formatSessionInfo", () => {
	it("formats cost with $ sign and 2 decimals not 4", () => {
		// given
		const stats = buildStats({ cost: 0.1234 });

		// when
		const rendered = stripAnsi(formatSessionInfo(stats));

		// then
		expect(rendered).toContain("$0.12");
		expect(rendered).not.toContain("0.1234");
	});

	it("includes Context Window section when contextUsage provided", () => {
		// given
		const stats = buildStats({
			contextUsage: { tokens: 21_897, contextWindow: 200_000, percent: 4 },
		});

		// when
		const rendered = stripAnsi(formatSessionInfo(stats));

		// then
		expect(rendered).toContain("Context Window");
		expect(rendered).toContain("21,897 / 200,000");
		expect(rendered).toContain("(4%)");
	});

	it("omits Context Window section when contextUsage missing", () => {
		// given
		const stats = buildStats({ contextUsage: undefined });

		// when
		const rendered = stripAnsi(formatSessionInfo(stats));

		// then
		expect(rendered).not.toContain("Context Window");
	});

	it("omits Cost section when cost is zero", () => {
		// given
		const stats = buildStats({ cost: 0 });

		// when
		const rendered = stripAnsi(formatSessionInfo(stats));

		// then
		expect(rendered).not.toContain("Cost\n");
		expect(rendered).not.toContain("$0.00");
	});

	it("formats large token counts with thousands separators", () => {
		// given
		const stats = buildStats({
			tokens: { input: 1_234_567, output: 89_012 },
		});

		// when
		const rendered = stripAnsi(formatSessionInfo(stats));

		// then
		expect(rendered).toContain("1,234,567");
		expect(rendered).toContain("89,012");
	});

	it("shows tokens-unknown placeholder in Context Window after compaction", () => {
		// given
		const stats = buildStats({
			contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
		});

		// when
		const rendered = stripAnsi(formatSessionInfo(stats));

		// then
		expect(rendered).toContain("Context Window");
		expect(rendered).toContain("200,000");
		expect(rendered).toContain("- / 200,000");
	});
});
