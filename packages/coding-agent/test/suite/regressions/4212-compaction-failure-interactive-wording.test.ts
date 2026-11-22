import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { REQUIRED_COMPACTION_ERROR_MESSAGE } from "../../../src/core/required-compaction-error.ts";
import { createAssistantRenderDescriptors } from "../../../src/modes/interactive/components/assistant-render-descriptors.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { REQUIRED_COMPACTION_INTERACTIVE_MESSAGE } from "../../../src/modes/interactive/required-compaction-wording.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

/**
 * senpi#4212: the failed-compaction error is surface-neutral for print mode, RPC and SDK
 * callers; only the TUI, which has `/compact` and `/new`, names them.
 */

function stripSgr(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("#4212 failed compaction wording in the TUI", () => {
	it("renders a turn that stopped on a failed compaction with the slash-command recovery", () => {
		initTheme("dark");
		const message: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: REQUIRED_COMPACTION_ERROR_MESSAGE }),
		};

		const errors = createAssistantRenderDescriptors(message, {
			expanded: false,
			hiddenThinkingLabel: "Thinking...",
			hideThinkingBlock: false,
			hasToolCalls: false,
		})
			.filter((descriptor) => descriptor.kind === "error-text")
			.map((descriptor) => stripSgr(descriptor.text));

		expect(errors).toEqual([`Error: ${REQUIRED_COMPACTION_INTERACTIVE_MESSAGE}`]);
	});

	it("shows a rejected prompt's failed compaction with the slash-command recovery", () => {
		initTheme("dark");
		const fixture = { chatContainer: new Container(), ui: { requestRender: vi.fn() } };

		InteractiveMode.prototype.showError.call(fixture, REQUIRED_COMPACTION_ERROR_MESSAGE);

		const rendered = stripSgr(fixture.chatContainer.children.flatMap((child) => child.render(400)).join("\n"));
		expect(rendered).toContain(`Error: ${REQUIRED_COMPACTION_INTERACTIVE_MESSAGE}`);
	});
});
