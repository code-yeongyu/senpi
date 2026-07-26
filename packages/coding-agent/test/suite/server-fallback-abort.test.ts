import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	BILLING_INCOMPLETE_DIAGNOSTIC,
	fauxAssistantMessage,
	SERVER_FALLBACK_ABORTED_DIAGNOSTIC,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

/**
 * What the provider layer hands the session after it aborts a substituted turn:
 * a classifier refusal with no content, tagged with the handoff diagnostic.
 */
function abortedByServerFallback(from: string, to: string): AssistantMessage {
	const explanation = `Server-side fallback (${from} -> ${to}) aborted by client policy`;
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: explanation,
			stopDetails: { type: "refusal", explanation },
		}),
		diagnostics: [
			{ type: SERVER_FALLBACK_ABORTED_DIAGNOSTIC, timestamp: 1, details: { from, to } },
			{ type: BILLING_INCOMPLETE_DIAGNOSTIC, timestamp: 1, details: { reason: "aborted" } },
		],
	};
}

function firstIndexOf(harness: Harness, type: string): number {
	return harness.events.findIndex((event) => event.type === type);
}

describe("server-side fallback abort routing", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("reports the handoff and routes the turn onto the configured chain", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([
			abortedByServerFallback("claude-fable-5", "claude-opus-4-8"),
			fauxAssistantMessage("chain answer"),
		]);

		await harness.session.prompt("audit this");

		expect(harness.eventsOfType("server_fallback_aborted")).toMatchObject([
			{ from: "claude-fable-5", to: "claude-opus-4-8", chainConfigured: true },
		]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, reason: "refusal" },
		]);
		// The UI must learn about the handoff before it learns about the switch.
		expect(firstIndexOf(harness, "server_fallback_aborted")).toBeLessThan(
			firstIndexOf(harness, "retry_fallback_applied"),
		);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		// The aborted turn is dropped from active context, so it never reaches the fallback request.
		expect(
			harness.session.state.messages.filter(
				(message) => message.role === "assistant" && message.stopDetails?.type === "refusal",
			),
		).toEqual([]);
	});

	it("reports that no chain is configured so the UI can point at /fallback", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([abortedByServerFallback("claude-opus-5", "claude-opus-4-6")]);

		await harness.session.prompt("audit this");

		expect(harness.eventsOfType("server_fallback_aborted")).toMatchObject([
			{ from: "claude-opus-5", to: "claude-opus-4-6", chainConfigured: false },
		]);
		// A refusal with no chain settles without exhaustion, so the abort event is
		// the only signal the UI gets for the missing-chain case.
		expect(harness.eventsOfType("retry_fallback_exhausted")).toEqual([]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps the abort diagnostics on the persisted turn", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([abortedByServerFallback("claude-fable-5", "claude-opus-4-8")]);

		await harness.session.prompt("audit this");

		const persisted = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const diagnostics = persisted.at(-1)?.type === "message" ? persisted.at(-1) : undefined;
		const types =
			diagnostics?.type === "message" && diagnostics.message.role === "assistant"
				? (diagnostics.message.diagnostics ?? []).map((entry) => entry.type)
				: [];
		expect(types).toContain(SERVER_FALLBACK_ABORTED_DIAGNOSTIC);
		expect(types).toContain(BILLING_INCOMPLETE_DIAGNOSTIC);
	});

	it("does not emit the event for an ordinary refusal", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "policy", stopDetails: { type: "refusal" } }),
		]);

		await harness.session.prompt("audit this");

		expect(harness.eventsOfType("server_fallback_aborted")).toEqual([]);
	});
});
