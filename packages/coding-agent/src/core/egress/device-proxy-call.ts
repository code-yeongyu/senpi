/**
 * Following one device call (row CK9; custody design 4.3-4.5). Frames are handled in order: `hooked` (seq 0) is stored
 * (W4') before any later frame is looked at, events are pushed as they arrive, and the terminal event is held until the
 * row is durably `ended`, then pushed, then acked. Silence is bounded with the loop's own numbers: a liveness probe
 * every half idle window re-attaches on progress, waits for a device offline longer than the resume window, and
 * cancels with `budget` after one idle window plus one resume window without progress.
 */
import type { DeviceId } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { EgressLedger } from "./ledger.ts";
import type { EgressCallRow } from "./ledger-schema.ts";
import { failureMessage, idleTimeoutText } from "./device-proxy-request.ts";
import { abortion, type EgressClock, type StepWaits, type WaitConditionSource } from "./device-proxy-waits.ts";
import type { SignedPlacementClaim } from "./placement-claim.ts";
import type {
	ProviderCallChannel,
	ProviderCallEnd,
	ProviderCallError,
	ProviderCallEvent,
	ProviderCallHooked,
	ProviderCallResultReply,
	ProviderCallStart,
} from "./wire.ts";

type Frame = ProviderCallHooked | ProviderCallEvent | ProviderCallEnd | ProviderCallError;
export type ClaimRefusal = "claim_expired" | "registry_key_revoked" | "registry_key_unknown";

export type CallOutcome =
	| { readonly kind: "ended" | "mismatch" | "unknown"; readonly row: EgressCallRow }
	| { readonly kind: "refused"; readonly row: EgressCallRow; readonly code: ClaimRefusal; readonly message: string };

export interface DeviceRouteBounds {
	readonly idleMs: number;
	readonly resumeWindowMs: number;
	readonly deadlineMs: number;
}

export interface CallContext {
	readonly out: AssistantMessageEventStream;
	readonly model: Model<Api>;
	readonly ledger: EgressLedger;
	readonly channel: ProviderCallChannel;
	readonly offlineFor: (deviceId: DeviceId) => number;
	readonly waits: StepWaits;
	readonly conditions: WaitConditionSource;
	readonly clock: EgressClock;
	readonly bounds: DeviceRouteBounds;
	readonly signal: AbortSignal;
	readonly claim: () => Promise<SignedPlacementClaim>;
	/** The row a user abort must cancel; kept current as `hooked` and `ended` replace it. */
	readonly live: { row: EgressCallRow | undefined };
}

const isTerminal = (event: AssistantMessageEvent): boolean => event.type === "done" || event.type === "error";

/** Sends `start` (or, to resume a row the brain already dispatched, first asks the hand for its result) and follows it. */
export async function followCall(
	ctx: CallContext,
	initial: EgressCallRow,
	begin: { readonly start: ProviderCallStart } | { readonly resume: true },
): Promise<CallOutcome> {
	const { channel, ledger, out, signal } = ctx;
	const deviceId = initial.deviceId;
	if (deviceId === undefined) throw new Error(`egress_call ${initial.callId} has no device`);
	const aborted = abortion(signal);
	let row = initial;
	ctx.live.row = row;
	let lastSeq = 0;
	let terminal: AssistantMessageEvent | undefined;
	const pushed: AssistantMessageEvent[] = [];
	let lastProgress = ctx.clock.now();
	let frames = channel.events(row.callId, 0)[Symbol.asyncIterator]();
	let pending: Promise<IteratorResult<Frame>> | undefined;

	const store = async (next: Promise<EgressCallRow>): Promise<void> => {
		row = await next;
		ctx.live.row = row;
	};
	const onEvent = (seq: number, event: AssistantMessageEvent): void => {
		if (seq <= lastSeq) return;
		lastSeq = seq;
		if (isTerminal(event)) {
			terminal = event;
			return;
		}
		pushed.push(event);
		out.push(event);
	};
	const settle = async (end: ProviderCallEnd | ProviderCallError): Promise<CallOutcome> => {
		if (end.t === "provider.call.error") return onError(end);
		if (!terminal) throw new Error(`device call ${row.callId} ended without a terminal event`);
		const events = [...pushed, terminal];
		await store(ledger.end(row, { kind: "message", events, usage: end.usage, stopReason: end.stopReason }));
		out.push(terminal);
		await channel.ack({ t: "provider.call.ack", callId: row.callId });
		return { kind: "ended", row };
	};
	const onError = async (error: ProviderCallError): Promise<CallOutcome> => {
		if (error.code === "definition_mismatch") return { kind: "mismatch", row };
		if (
			error.code === "claim_expired" ||
			error.code === "registry_key_revoked" ||
			error.code === "registry_key_unknown"
		)
			return { kind: "refused", row, code: error.code, message: error.message };
		if (error.code === "aborted" && signal.aborted) throw signal.reason;
		const { code, message, retryable, usage } = error;
		await store(ledger.end(row, { kind: "error", code, message, retryable, ...(usage ? { usage } : {}) }));
		const stopReason = code === "aborted" ? "aborted" : "error";
		out.push({ type: "error", reason: stopReason, error: failureMessage(ctx.model, stopReason, message, usage) });
		await channel.ack({ t: "provider.call.ack", callId: row.callId });
		return { kind: "ended", row };
	};
	const onReply = async (reply: ProviderCallResultReply): Promise<CallOutcome | undefined> => {
		if (reply.state === "unknown") return { kind: "unknown", row };
		if (reply.hooked && !row.hooksApplied)
			await store(ledger.recordHooked(row, JSON.stringify(reply.hooked.request)));
		if (reply.state === "running") {
			if (reply.lastSeq > lastSeq) {
				frames = channel.events(row.callId, lastSeq + 1)[Symbol.asyncIterator]();
				pending = undefined;
				lastProgress = ctx.clock.now();
			}
			return undefined;
		}
		reply.events.forEach((event, index) => onEvent(index + 1, event));
		return settle(reply.end);
	};
	const query = async (): Promise<CallOutcome | undefined> =>
		onReply(
			await Promise.race([
				channel.result({ t: "provider.call.result", callId: row.callId, claim: await ctx.claim() }),
				aborted,
			]),
		);
	const probe = async (): Promise<CallOutcome | undefined> => {
		if (ctx.offlineFor(deviceId) >= ctx.bounds.resumeWindowMs) {
			const waitFor = [{ kind: "device-online", deviceId }] as const;
			const steer = `open omo on ${deviceId}`;
			await ctx.waits.hold({ reason: "device-offline", steer, waitFor }, ctx.conditions.until(waitFor, signal));
			lastProgress = ctx.clock.now();
		} else if (ctx.clock.now() - lastProgress >= ctx.bounds.idleMs + ctx.bounds.resumeWindowMs) {
			await channel.cancel({ t: "provider.call.cancel", callId: row.callId, reason: "budget" });
			throw new Error(idleTimeoutText(ctx.bounds.idleMs));
		}
		return query();
	};

	if ("start" in begin) await Promise.race([channel.start(begin.start), aborted]);
	else {
		const resumed = await query();
		if (resumed) return resumed;
	}
	for (;;) {
		pending ??= frames.next();
		const sleeper = new AbortController();
		const tick = ctx.clock.sleep(ctx.bounds.idleMs / 2, sleeper.signal).then(
			() => "probe" as const,
			() => new Promise<never>(() => {}),
		);
		const next = await Promise.race([pending, tick, aborted]);
		sleeper.abort();
		if (next === "probe") {
			const outcome = await probe();
			if (outcome) return outcome;
			continue;
		}
		pending = undefined;
		if (next.done) {
			const outcome = await query();
			if (outcome) return outcome;
			continue;
		}
		const frame = next.value;
		lastProgress = ctx.clock.now();
		if (frame.t === "provider.call.hooked") await store(ledger.recordHooked(row, JSON.stringify(frame.request)));
		else if (frame.t === "provider.call.event") onEvent(frame.seq, frame.event);
		else return settle(frame);
	}
}
