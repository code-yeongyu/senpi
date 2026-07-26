import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";
import { GrokFooter } from "../../src/modes/interactive/grok/footer.ts";
import { fg, GROK_COLOR_MODES, initGrokTheme, resetGrokThemeCapabilities } from "./theme-assertions.ts";

const session = {
	state: { model: { id: "faux-1" } },
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
	});
}
