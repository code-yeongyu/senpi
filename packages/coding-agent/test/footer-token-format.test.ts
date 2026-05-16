import { describe, expect, it, vi } from "vitest";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { stripAnsi } from "../src/utils/ansi.js";

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
							input: 3,
							output: 101,
							cacheRead: 6_982,
							cacheWrite: 16_356,
							cost: { total: 0 },
						},
					},
				},
			],
			getSessionName: () => "",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ tokens: 23_442, contextWindow: 800_000, percent: 2.93025 }),
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
	it("renders opencode-style aggregate context usage instead of compact counters", () => {
		// given
		const Footer = FooterComponent as new (
			session: unknown,
			footerData: unknown,
		) => { render(width: number): string[] };
		const footer = new Footer(createSession(), createFooterData());

		// when
		const rendered = stripAnsi(footer.render(160).join("\n"));

		// then
		expect(rendered).toContain("23.4K (3%)");
		expect(rendered).not.toContain("↑3");
		expect(rendered).not.toContain("↓101");
		expect(rendered).not.toContain("R6982");
		expect(rendered).not.toContain("W16356");
		expect(rendered).not.toContain("2.9%/800000");
		expect(rendered).not.toContain("(auto)");
	});
});
