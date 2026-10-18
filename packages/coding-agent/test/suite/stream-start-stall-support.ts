import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantRenderDescriptors } from "../../src/modes/interactive/components/assistant-render-descriptors.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import type { Harness } from "./harness.ts";

/**
 * The agent-loop stream-start watchdog's own `Error.message`. It is a classifier
 * token for the retry engine (`isProviderStreamStallError`), never the copy a
 * user is supposed to read as the answer to their turn - senpi#1740.
 */
export const RAW_STREAM_START_WATCHDOG = /Provider stream start timed out after \d+ms/;

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/**
 * A provider stub that accepts the request and never emits a first stream event,
 * so the only thing that can settle the attempt is the stream-start watchdog.
 * It resolves once the loop aborts the dead request, which releases the faux
 * stream instead of leaving a promise pending for the rest of the run.
 */
export function neverStartsStream(): FauxResponseStep {
	return (_context, options) =>
		new Promise<AssistantMessage>((resolve) => {
			const settle = () =>
				resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }));
			const signal = options?.signal;
			if (!signal) return;
			if (signal.aborted) {
				settle();
				return;
			}
			signal.addEventListener("abort", settle, { once: true });
		});
}

let themeReady = false;

/** The descriptor builder reads the global theme; the transcript is what we assert on. */
function ensureTheme(): void {
	if (themeReady) return;
	initTheme("dark");
	themeReady = true;
}

/** The error lines the interactive transcript prints for every assistant turn it saw. */
export function visibleErrorLines(harness: Harness): string[] {
	ensureTheme();
	return harness
		.eventsOfType("message_end")
		.filter((event) => event.message.role === "assistant")
		.flatMap((event) =>
			createAssistantRenderDescriptors(event.message as AssistantMessage, {
				expanded: false,
				hiddenThinkingLabel: "",
				hideThinkingBlock: true,
				hasToolCalls: false,
			}),
		)
		.filter((descriptor) => descriptor.kind === "error-text")
		.map((descriptor) => descriptor.text.replace(ANSI_PATTERN, ""));
}
