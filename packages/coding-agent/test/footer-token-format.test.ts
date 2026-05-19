import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/utils/ansi.js";

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
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ tokens: 44_000, contextWindow: 800_000, percent: 5.5 }),
		modelRegistry: {
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

describe("FooterComponent token formatting", () => {
	it("renders comma-formatted token counters and context window usage", async () => {
		// given
		const { FooterComponent } = await import("../src/modes/interactive/components/footer.js");
		const Footer = FooterComponent as new (
			session: unknown,
			footerData: unknown,
		) => { render(width: number): string[] };
		const footer = new Footer(createSession(), createFooterData());

		// when
		const rendered = stripAnsi(footer.render(160).join("\n"));

		// then
		expect(rendered).toContain("↑49");
		expect(rendered).toContain("↓6,800");
		expect(rendered).toContain("cache 1,500,000/44,000");
		expect(rendered).toContain("44,000/800,000 (5.5%) (auto)");
		expect(rendered).not.toContain("23.4K (3%)");
		expect(rendered).not.toContain("↓6.8k");
		expect(rendered).not.toContain("R1,500,000");
		expect(rendered).not.toContain("W44,000");
		expect(rendered).not.toContain("R1.5M");
		expect(rendered).not.toContain("W44k");
		expect(rendered).not.toContain("5.5%/800,000 (auto)");
		expect(rendered).not.toContain("5.5%/800k (auto)");
	});
});
