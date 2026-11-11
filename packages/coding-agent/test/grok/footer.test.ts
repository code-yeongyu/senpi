import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { GrokFooter } from "../../src/modes/interactive/grok/footer.ts";
import { fg, GROK_COLOR_MODES, initGrokTheme, resetGrokThemeCapabilities } from "./theme-assertions.ts";

const session = {
	state: { model: { id: "faux-1" } },
	supportsThinking: () => false,
	sessionManager: { getCwd: () => "/workspace/project" },
} as unknown as AgentSession;

const footerData = {
	getGitBranch: () => null,
	getExtensionStatuses: () => new Map(),
	getAvailableProviderCount: () => 0,
	onBranchChange: () => () => {},
} as ReadonlyFooterDataProvider;

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`GrokFooter (${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});

		it("resolves the model label and cwd from active-theme chrome tokens", () => {
			const footer = new GrokFooter(session, footerData);
			expect(footer.render(80)).toEqual([`${fg("dim", "/workspace/project")} ${fg("thinkingText", "faux-1")}`]);
		});

		it("reflects the session's current thinking level", () => {
			const thinkingSession = {
				...session,
				thinkingLevel: "high" as AgentSession["thinkingLevel"],
				supportsThinking: () => true,
			};
			const footer = new GrokFooter(thinkingSession as AgentSession, footerData);
			expect(footer.render(80)).toEqual([
				`${fg("dim", "/workspace/project")} ${fg("thinkingText", "faux-1:high")}`,
			]);
			thinkingSession.thinkingLevel = "xhigh";
			footer.invalidate();
			expect(footer.render(80)).toEqual([
				`${fg("dim", "/workspace/project")} ${fg("thinkingText", "faux-1:xhigh")}`,
			]);
		});

		it.each([24, 10])("keeps thinking feedback visible at %i columns", (width) => {
			const thinkingSession = {
				...session,
				thinkingLevel: "high" as const,
				supportsThinking: () => true,
			};
			const footer = new GrokFooter(thinkingSession as AgentSession, footerData);
			const lines = footer.render(width);
			expect(lines).toEqual([expect.stringContaining(":high")]);
			expect(visibleWidth(lines.join(""))).toBeLessThanOrEqual(width);
		});
	});
}
