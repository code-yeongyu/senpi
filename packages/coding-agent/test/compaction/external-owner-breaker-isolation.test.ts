/**
 * External-owner breaker isolation (PR #1194 review 3887849886).
 *
 * When the Claude Agent SDK owns a session's compaction lane, senpi stands
 * down. That stand-down is a *policy* outcome, not a senpi failure, so it must
 * stay invisible to senpi's own health accounting:
 *
 *  1. an `external-owner` rejection must never debit the circuit breaker, and
 *  2. the breaker's deterministic context-reduction fallback must never fire
 *     while another lane owns compaction — the lane contract forbids senpi from
 *     rewriting a history it does not own.
 *
 * The guards are independent on purpose: even a breaker tripped by earlier
 * senpi-owned failures must not reduce context once the session moves onto an
 * SDK-native lane.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { FAILURE_TRIP_THRESHOLD } from "../../src/core/extensions/builtin/compaction/circuit-breaker.ts";
import { buildCompactionContext } from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
} from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

interface BreakerHarness {
	sessionCompact: NonNullable<ExtensionHandler<SessionCompactEvent, void>>;
	sessionBeforeCompact: NonNullable<ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>>;
	senpiOwnedCtx: ExtensionContext;
}

function fauxModel(): Model<Api> {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return registration.getModel();
}

function createHarness(): BreakerHarness {
	const handlers = new Map<string, ExtensionHandler<never, unknown>>();
	compactionExtension({
		events: { emit: () => undefined },
		on: (event: string, handler: ExtensionHandler<never, unknown>) => handlers.set(event, handler),
	} as unknown as ExtensionAPI);
	const sessionCompact = handlers.get("session_compact");
	const sessionBeforeCompact = handlers.get("session_before_compact");
	expect(sessionCompact).toBeDefined();
	expect(sessionBeforeCompact).toBeDefined();
	const senpiOwnedCtx = {
		hasUI: false,
		mode: "print",
		ui: { notify: () => undefined },
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager: SessionManager.inMemory(),
		model: fauxModel(),
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 2_000 }),
		getMessageRevision: () => 1,
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	return {
		sessionCompact: sessionCompact as unknown as BreakerHarness["sessionCompact"],
		sessionBeforeCompact: sessionBeforeCompact as unknown as BreakerHarness["sessionBeforeCompact"],
		senpiOwnedCtx,
	};
}

function rejectedCompactEvent(
	round: number,
	rejectionCause: "external-owner" | "cancelled-by-extension",
): SessionCompactEvent {
	return {
		type: "session_compact",
		reason: "threshold",
		requestId: `lane-${round}`,
		accepted: false,
		rejectionCause,
		fromExtension: false,
		willRetry: false,
	};
}

function beforeCompactEvent(): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "threshold",
		willRetry: false,
		requestId: "probe",
		preparation: {} as SessionBeforeCompactEvent["preparation"],
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

/** Six read tool-result pairs — large enough for the reduction pass to rewrite. */
function reducibleMessages(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 6; index++) {
		messages.push({
			role: "assistant",
			content: [
				{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path: `/src/file-${index}.ts` } },
			],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: index * 2,
		} as AgentMessage);
		messages.push({
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text", text: `line of file ${index} `.repeat(400) }],
			isError: false,
			timestamp: index * 2 + 1,
		} as AgentMessage);
	}
	return messages;
}

function buildContext(options: { breakerFallback: boolean; laneOwnsCompaction: boolean }): string {
	const ctx = {
		model: fauxModel(),
		cwd: process.cwd(),
		sessionManager: SessionManager.inMemory(),
		// Deliberately below the 50% reduction gate, so `breakerFallback` is the
		// only input that can pull the reduction pass in.
		getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000, percent: 1 }),
	} as unknown as ExtensionContext;
	const event: ContextEvent = { type: "context", messages: reducibleMessages() };
	return JSON.stringify(
		buildCompactionContext({
			event,
			ctx,
			contextWindow: 100_000,
			promptContextWindow: 100_000,
			toolAdmissionEnabled: false,
			breakerFallback: options.breakerFallback,
			laneOwnsCompaction: options.laneOwnsCompaction,
			emergencyPruneLatch: createEmergencyPruneLatch(),
		}),
	);
}

describe("external-owner breaker isolation", () => {
	describe("Given a session whose compaction lane is owned externally", () => {
		describe("When senpi stands down for every compaction attempt", () => {
			it("Then the external-owner rejections never trip senpi's circuit breaker", async () => {
				const harness = createHarness();

				for (let round = 0; round < FAILURE_TRIP_THRESHOLD; round++) {
					await harness.sessionCompact(rejectedCompactEvent(round, "external-owner"), harness.senpiOwnedCtx);
				}
				const decision = await harness.sessionBeforeCompact(beforeCompactEvent(), harness.senpiOwnedCtx);

				expect(decision?.rejectionCause).not.toBe("circuit-breaker");
			});
		});

		describe("When the breaker is already tripped by earlier senpi-owned failures", () => {
			it("Then the deterministic fallback leaves the externally owned context untouched", () => {
				const untouched = buildContext({ breakerFallback: false, laneOwnsCompaction: true });

				const withTrippedBreaker = buildContext({ breakerFallback: true, laneOwnsCompaction: true });

				expect(withTrippedBreaker).toBe(untouched);
			});
		});
	});

	describe("Given a session senpi owns", () => {
		describe("When ordinary compaction rejections accumulate", () => {
			it("Then the breaker still trips on the third failure", async () => {
				const harness = createHarness();

				for (let round = 0; round < FAILURE_TRIP_THRESHOLD; round++) {
					await harness.sessionCompact(
						rejectedCompactEvent(round, "cancelled-by-extension"),
						harness.senpiOwnedCtx,
					);
				}
				const decision = await harness.sessionBeforeCompact(beforeCompactEvent(), harness.senpiOwnedCtx);

				expect(decision?.rejectionCause).toBe("circuit-breaker");
			});
		});

		describe("When the breaker trips below the reduction gate", () => {
			it("Then the deterministic fallback still reduces the context", () => {
				const untouched = buildContext({ breakerFallback: false, laneOwnsCompaction: false });

				const reduced = buildContext({ breakerFallback: true, laneOwnsCompaction: false });

				expect(reduced).not.toBe(untouched);
			});
		});
	});
});
