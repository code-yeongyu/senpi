import { visibleWidth } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const session = Object.create(AgentSession.prototype) as AgentSession;
	Object.defineProperties(session, {
		state: {
			value: {
				model: {
					id: options.modelId ?? "test-model",
					provider: options.provider ?? "test",
					contextWindow: 200_000,
					reasoning: options.reasoning ?? false,
				},
				thinkingLevel: options.thinkingLevel ?? "off",
			},
		},
		sessionManager: {
			value: {
				getEntries: () => entries,
				getSessionName: () => options.sessionName,
				getCwd: () => "/tmp/project",
			},
		},
		getContextUsage: {
			value: () => ({ contextWindow: 200_000, percent: 12.3 }),
		},
		modelRegistry: {
			value: {
				isUsingOAuth: () => false,
			},
		},
	});

	return session;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("renders the context window as a raw token count", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(120);

		expect(lines[1]).toContain("12.3%/200000");
		expect(lines[1]).not.toContain("200k");
	});
});
