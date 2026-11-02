import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/index.ts";
import type { SessionBeforeCompactEvent } from "../../src/core/extensions/index.ts";
import {
	createBeforeAgentStartEvent,
	createBlockingContext,
	createCompactionHandlers,
} from "../helpers/blocking-compaction-harness.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

function coreCompactEvent(
	harness: ReturnType<typeof createBlockingContext>,
	overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
	const branchEntries = harness.sessionManager.getBranch();
	const preparation = prepareCompaction(branchEntries, harness.ctx.getCompactionSettings());
	if (!preparation) throw new Error("fixture is not compactable");
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: false,
		requestId: randomUUID(),
		preparation,
		branchEntries,
		signal: new AbortController().signal,
		...overrides,
	};
}

/**
 * On a new prompt the core admission path runs BEFORE `before_agent_start`
 * (agent-session.ts `_enforceCompactionBeforeProvider` precedes
 * `emitBeforeAgentStart`), so the core route reaches compaction first and its
 * `session_before_compact` handler decides the fate of any warm summary the
 * idle warm-up already paid for.
 */
describe("Given a completed idle warm summary and a core-route compaction", () => {
	it("Then the core route consumes the warm summary instead of billing a second one", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);
		harness.registration.setResponses([
			fauxAssistantMessage("warm summary paid for while the user was away"),
			fauxAssistantMessage("fresh summary the user should never wait for"),
		]);

		// Given: the warm-up band starts a speculative job and it settles.
		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		await new Promise((resolve) => setImmediate(resolve));

		// When: the core route asks the extension for a summary.
		const result = await handlers.sessionBeforeCompact(coreCompactEvent(harness), harness.ctx);

		// Then: the warm result is handed over, so only the warm-up was billed.
		expect(result?.compaction?.summary).toContain("warm summary paid for while the user was away");
		expect(harness.registration.state.callCount).toBe(1);
	});

	it("Then a warm summary cut at a different boundary is refused and regenerated once", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);
		harness.registration.setResponses([
			fauxAssistantMessage("warm summary for a different cut"),
			fauxAssistantMessage("fresh summary matching the core preparation"),
		]);

		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		await new Promise((resolve) => setImmediate(resolve));

		// When: core's own preparation cuts somewhere the warm summary does not cover.
		const event = coreCompactEvent(harness);
		const mismatched: SessionBeforeCompactEvent = {
			...event,
			preparation: { ...event.preparation, firstKeptEntryId: "a-boundary-the-warm-summary-never-covered" },
		};
		const result = await handlers.sessionBeforeCompact(mismatched, harness.ctx);

		// Then: the stale-cut warm result must never be handed to core.
		expect(result?.compaction?.summary).not.toContain("warm summary for a different cut");
		expect(harness.registration.state.callCount).toBe(2);
	});

	it("Then a manual compaction carrying custom instructions never reuses the idle summary", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);
		harness.registration.setResponses([
			fauxAssistantMessage("warm summary written for the automatic policy"),
			fauxAssistantMessage("fresh summary honouring the user's instructions"),
		]);

		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		await new Promise((resolve) => setImmediate(resolve));

		// When: the user asks for a compaction with their own instructions.
		const result = await handlers.sessionBeforeCompact(
			coreCompactEvent(harness, { reason: "manual", customInstructions: "focus on the API decisions" }),
			harness.ctx,
		);

		// Then: an idle summary written under different instructions is not substituted.
		expect(result?.compaction?.summary).not.toContain("warm summary written for the automatic policy");
		expect(harness.registration.state.callCount).toBe(2);
	});

	it("Then a warm summary is refused after a compaction boundary lands", async () => {
		const handlers = createCompactionHandlers();
		const harness = createBlockingContext({ usageTokens: 4_000 });
		registrations.push(harness.registration);
		harness.registration.setResponses([
			fauxAssistantMessage("warm summary describing pre-boundary history"),
			fauxAssistantMessage("fresh summary for the rewritten history"),
		]);

		await handlers.beforeAgentStart(createBeforeAgentStartEvent(), harness.ctx);
		await new Promise((resolve) => setImmediate(resolve));

		// When: another route commits a compaction before this one is admitted.
		harness.sessionManager.appendCompaction(
			"a boundary committed by another route",
			harness.sessionManager.getBranch()[0].id,
			1_000,
		);
		// prepareCompaction refuses a branch whose tip is a compaction record, so the
		// session must carry work past the new boundary to be compactable again.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "work after the new boundary" }],
			timestamp: 9,
		});
		const event = coreCompactEvent(harness);
		const result = await handlers.sessionBeforeCompact(event, harness.ctx);

		// Then: the warm summary describes history that no longer exists.
		expect(result?.compaction?.summary).not.toContain("warm summary describing pre-boundary history");
	});
});
