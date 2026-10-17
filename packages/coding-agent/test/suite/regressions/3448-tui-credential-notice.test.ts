import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

function render(container: Container): string {
	return container.children.flatMap((child) => child.render(160)).join("\n");
}

/**
 * senpi#3486 review: the credential and billing notices reached only non-interactive runs. The TUI
 * start path must render them and mark them seen, so each change is shown once.
 */
describe("the TUI shows pending credential notices at startup (senpi#3486)", () => {
	beforeAll(() => initTheme("dark"));

	it("renders each notice and marks them seen once", async () => {
		const harness = await createHarness();
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		try {
			const chatContainer = new Container();
			const markSeen = vi.fn();
			const message =
				"openrouter: an API key saved earlier is stored next to your OAuth login but is never used; the OAuth login stays in use.";
			const context = {
				init: vi.fn(async () => {}),
				options: { authNotices: { messages: [message], markSeen } },
				chatContainer,
				outputPad: 1,
				ui: { requestRender: vi.fn() },
				version: "test",
				showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
				session: harness.session,
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxSetup: vi.fn().mockResolvedValue(undefined),
				showRiskyMainModelWarning: vi.fn(),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};
			const run = (InteractiveMode.prototype as unknown as { run(this: typeof context): Promise<void> }).run;

			void run.call(context);

			await vi.waitFor(() => {
				expect(render(chatContainer)).toContain("Warning: openrouter: an API key saved earlier");
			});
			expect(markSeen).toHaveBeenCalledTimes(1);
		} finally {
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			harness.cleanup();
		}
	});
});
