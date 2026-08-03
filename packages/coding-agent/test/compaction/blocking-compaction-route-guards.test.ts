import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILURE_TRIP_THRESHOLD } from "../../src/core/extensions/builtin/compaction/circuit-breaker.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { softCap } from "../../src/core/extensions/builtin/compaction/per-turn-cap.ts";
import type { ExtensionHandler } from "../../src/core/extensions/index.ts";
import {
	connectionErrorResponse,
	createBeforeAgentStartEvent,
	createBlockingContext,
} from "../helpers/blocking-compaction-harness.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function captureHandlers(): Map<string, ExtensionHandler<never, unknown>> {
	const handlers = new Map<string, ExtensionHandler<never, unknown>>();
	compactionExtension({
		on: (event: string, handler: ExtensionHandler<never, unknown>) => handlers.set(event, handler),
	} as never);
	return handlers;
}

function acceptedCompactionEvent(round: number, savedTokens: number) {
	return {
		type: "session_compact",
		reason: "extension",
		requestId: `guard-${round}`,
		accepted: true,
		fromExtension: true,
		willRetry: false,
		compactionEntry: {
			type: "compaction",
			id: `cmp-guard-${round}`,
			parentId: null,
			timestamp: new Date(round).toISOString(),
			summary: "summary",
			firstKeptEntryId: "keep",
			tokensBefore: 9_950,
			fromHook: true,
			details: {
				structuralYield: { savedTokens, savingsRatio: savedTokens / 9_950 },
			},
		},
	};
}

describe("blocking compaction route guards (issue #527)", () => {
	it("stops hard-limit blocking attempts when the circuit breaker trips", async () => {
		const handlers = captureHandlers();
		const beforeAgentStart = handlers.get("before_agent_start");
		expect(beforeAgentStart).toBeDefined();
		const harness = createBlockingContext({ usageTokens: 9_950 });
		registrations.push(harness.registration);
		harness.registration.setResponses(Array.from({ length: 8 }, () => connectionErrorResponse()));

		for (let attempt = 0; attempt < 8; attempt++) {
			await beforeAgentStart?.(createBeforeAgentStartEvent() as never, harness.ctx);
		}

		expect(harness.registration.state.callCount).toBe(FAILURE_TRIP_THRESHOLD);
	});

	it("bounds successful hard-limit blocking compactions by the soft cap", async () => {
		const handlers = captureHandlers();
		const beforeAgentStart = handlers.get("before_agent_start");
		const sessionCompact = handlers.get("session_compact");
		expect(beforeAgentStart).toBeDefined();
		expect(sessionCompact).toBeDefined();
		const harness = createBlockingContext({ usageTokens: 9_950 });
		registrations.push(harness.registration);
		const attempts = softCap * 4;
		harness.registration.setResponses(
			Array.from({ length: attempts }, () => fauxAssistantMessage("## Goal\ncompact summary")),
		);

		for (let round = 0; round < attempts; round++) {
			const appliedBefore = (harness.ctx.applyCompaction as ReturnType<typeof vi.fn>).mock.calls.length;
			await beforeAgentStart?.(createBeforeAgentStartEvent() as never, harness.ctx);
			const appliedAfter = (harness.ctx.applyCompaction as ReturnType<typeof vi.fn>).mock.calls.length;
			if (appliedAfter > appliedBefore) {
				await sessionCompact?.(acceptedCompactionEvent(round, 8_000) as never, harness.ctx);
			}
		}

		expect((harness.ctx.applyCompaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(softCap);
	});

	it("admits compaction again after the provider turn ends", async () => {
		const handlers = captureHandlers();
		const beforeAgentStart = handlers.get("before_agent_start");
		const sessionCompact = handlers.get("session_compact");
		const turnEnd = handlers.get("turn_end");
		expect(beforeAgentStart).toBeDefined();
		expect(sessionCompact).toBeDefined();
		expect(turnEnd).toBeDefined();
		const harness = createBlockingContext({ usageTokens: 9_950 });
		registrations.push(harness.registration);
		harness.registration.setResponses(
			Array.from({ length: softCap + 1 }, () => fauxAssistantMessage("## Goal\ncompact summary")),
		);

		for (let round = 0; round < softCap; round++) {
			await beforeAgentStart?.(createBeforeAgentStartEvent() as never, harness.ctx);
			await sessionCompact?.(acceptedCompactionEvent(round, 8_000) as never, harness.ctx);
		}
		await turnEnd?.({ type: "turn_end" } as never, harness.ctx);
		await beforeAgentStart?.(createBeforeAgentStartEvent() as never, harness.ctx);

		expect((harness.ctx.applyCompaction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(softCap + 1);
	});

	it("resets the soft cap on turn_end even after degradation recovery fires", async () => {
		const handlers = captureHandlers();
		const beforeAgentStart = handlers.get("before_agent_start");
		const sessionCompact = handlers.get("session_compact");
		const messageEnd = handlers.get("message_end");
		const turnEnd = handlers.get("turn_end");
		expect(beforeAgentStart).toBeDefined();
		expect(sessionCompact).toBeDefined();
		expect(messageEnd).toBeDefined();
		expect(turnEnd).toBeDefined();
		const harness = createBlockingContext({ usageTokens: 9_950 });
		registrations.push(harness.registration);
		harness.registration.setResponses(
			Array.from({ length: softCap + 2 }, () => fauxAssistantMessage("## Goal\ncompact summary")),
		);

		// Fill the soft cap with accepted compactions this provider turn.
		for (let round = 0; round < softCap; round++) {
			await beforeAgentStart?.(createBeforeAgentStartEvent() as never, harness.ctx);
			await sessionCompact?.(acceptedCompactionEvent(round, 8_000) as never, harness.ctx);
		}
		const appliedAtCap = (harness.ctx.applyCompaction as ReturnType<typeof vi.fn>).mock.calls.length;

		// Trigger post-compaction degradation recovery: three no-text assistant
		// turns set recoveryTriggeredThisCycle, which used to skip the turn_end
		// counter reset when the reset was not in `finally`.
		for (let turn = 0; turn < 3; turn++) {
			await messageEnd?.(
				{
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" },
				} as never,
				harness.ctx,
			);
		}
		await turnEnd?.({ type: "turn_end" } as never, harness.ctx);

		// The next provider turn must open at a fresh soft counter and admit.
		await beforeAgentStart?.(createBeforeAgentStartEvent() as never, harness.ctx);
		expect((harness.ctx.applyCompaction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(appliedAtCap);
	});

	it("counts zero-yield attempts before admitting turn-end recovery", async () => {
		const handlers = captureHandlers();
		const turnEnd = handlers.get("turn_end");
		const sessionCompact = handlers.get("session_compact");
		expect(turnEnd).toBeDefined();
		expect(sessionCompact).toBeDefined();
		const controller = new AbortController();
		controller.abort();
		const beginCompaction = vi.fn(() => controller.signal);
		const harness = createBlockingContext({ usageTokens: 9_950, beginCompaction });
		registrations.push(harness.registration);
		harness.registration.setResponses([fauxAssistantMessage("## Goal\nrecovery summary")]);

		await sessionCompact?.(acceptedCompactionEvent(0, 0) as never, harness.ctx);
		await sessionCompact?.(acceptedCompactionEvent(1, 0) as never, harness.ctx);
		await turnEnd?.({ type: "turn_end" } as never, harness.ctx);

		expect(beginCompaction).not.toHaveBeenCalled();
	});
});
