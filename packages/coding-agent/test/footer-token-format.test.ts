import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";

vi.mock("@earendil-works/pi-tui", async () => import("@earendil-works/pi-tui"));
vi.mock("../src/modes/interactive/theme/theme.js", () => ({
	theme: {
		fg: (_color: string, text: string) => text,
	},
}));

function createSession(): unknown {
	const session = {
		state: {
			model: {
				id: "test-model",
				provider: "test",
				contextWindow: 1_600_000,
				reasoning: false,
			},
			thinkingLevel: "off",
		},
		sessionManager: {
			getEntries: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: {
							input: 49,
							output: 6_800,
							cacheRead: 1_500_000,
							cacheWrite: 44_000,
							cost: { total: 0 },
						},
					},
				},
			],
			getUsageTotals: () => ({
				input: 49,
				output: 6_800,
				cacheRead: 1_500_000,
				cacheWrite: 44_000,
				cost: 0,
				latestCacheHitRate: (1_500_000 / (49 + 1_500_000 + 44_000)) * 100,
			}),
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ tokens: 44_000, contextWindow: 800_000, percent: 5.5 }),
		modelRuntime: {
			isUsingOAuth: () => false,
		},
	};

	return session;
}

function createFooterData(): unknown {
	return {
		getGitBranch: () => undefined,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

describe("formatTokens abbreviation", () => {
	it("abbreviates with oh-my-pi K/M/B notation", async () => {
		const { formatTokens } = await import("../src/modes/interactive/components/footer.ts");
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(6_800)).toBe("6.8K");
		expect(formatTokens(44_000)).toBe("44K");
		expect(formatTokens(545_661)).toBe("546K");
		expect(formatTokens(1_000_000)).toBe("1M");
		expect(formatTokens(1_500_000)).toBe("1.5M");
		expect(formatTokens(800_000)).toBe("800K");
	});
});

describe("FooterComponent token formatting", () => {
	it("renders oh-my-pi-style abbreviated token counters and context window usage", async () => {
		// given
		const { FooterComponent } = await import("../src/modes/interactive/components/footer.ts");
		const Footer = FooterComponent as new (
			session: unknown,
			footerData: unknown,
		) => { render(width: number): string[] };
		const footer = new Footer(createSession(), createFooterData());

		// when
		const rendered = stripAnsi(footer.render(160).join("\n"));

		// then
		expect(rendered).toContain("↑49");
		expect(rendered).toContain("↓6.8K");
		expect(rendered).toContain("cache 1.5M/44K");
		expect(rendered).toContain("44K/800K (5.5%) (auto)");
		expect(rendered).not.toContain("44,000/800,000");
		expect(rendered).not.toContain("↓6,800");
		expect(rendered).not.toContain("cache 1,500,000/44,000");
		expect(rendered).not.toContain("↓6.8k");
		expect(rendered).not.toContain("R1,500,000");
		expect(rendered).not.toContain("W44,000");
		expect(rendered).not.toContain("5.5%/800K (auto)");
		expect(rendered).not.toContain("5.5%/800k (auto)");
	});
});
