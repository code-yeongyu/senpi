/**
 * Following one device call (row CK9; custody design 4.3-4.5). Frames are handled in order: `hooked` is stored (W4')
 * only as the call's seq-0 frame while the stored request has no hooks applied (a late or unsolicited `hooked` never
 * rewrites the stored request), events are pushed as they arrive, and the terminal event is held until the row is
 * durably `ended` with the assembled message, then pushed, then acked. Silence is bounded with the loop's own numbers:
 * a liveness probe every half idle window re-attaches on progress, waits for a device offline longer than the resume
 * window, and cancels with `budget` after one idle window plus one resume window without progress. An events stream
 * that ends before the terminal frame is parked, so the probe (and with it the bound) keeps running. Open question
 * (design 4.4 "or stream-start bound without a first event"): the design names no value for that bound on this seam,
 * so the idle+resume bound also covers a call with no first event until CK1 exports the loop's stream-start constant.
 */
import type { DeviceId } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEvent, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { EgressLedger } from "./ledger.ts";
import type { EgressCallRow } from "./ledger-schema.ts";
import { failureMessage, idleTimeoutText, storedRequestJson } from "./device-proxy-request.ts";
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

type TerminalEvent = Extract<AssistantMessageEvent, { readonly type: "done" | "error" }>;

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
	let terminal: TerminalEvent | undefined;
	let lastProgress = ctx.clock.now();
	let frames = channel.events(row.callId, 0)[Symbol.asyncIterator]();
	let pending: Promise<IteratorResult<Frame>> | undefined;
	/** The events stream ended before the terminal frame: only the timed probe can move the call on until it re-attaches. */
	let streamEnded = false;
	const parked = new Promise<never>(() => {});
	const close = (stream: AsyncIterator<Frame>): void => {
		stream.return?.().catch(() => {});
	};
	const reattach = (fromSeq: number): void => {
		close(frames);
		frames = channel.events(row.callId, fromSeq)[Symbol.asyncIterator]();
		pending = undefined;
		streamEnded = false;
	};

	const store = async (next: Promise<EgressCallRow>): Promise<void> => {
		row = await next;
		ctx.live.row = row;
	};
	const onEvent = (seq: number, event: AssistantMessageEvent): void => {
		if (seq <= lastSeq) return;
		lastSeq = seq;
		if (event.type === "done" || event.type === "error") {
			terminal = event;
			return;
		}
		out.push(event);
	};
	const settle = async (end: ProviderCallEnd | ProviderCallError): Promise<CallOutcome> => {
		if (end.t === "provider.call.error") return onError(end);
		if (!terminal) throw new Error(`device call ${row.callId} ended without a terminal event`);
		const message = terminal.type === "done" ? terminal.message : terminal.error;
		await store(ledger.end(row, { kind: "message", message }));
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
			await store(ledger.recordHooked(row, storedRequestJson(reply.hooked.request)));
		if (reply.state === "running") {
			if (reply.lastSeq > lastSeq) {
				reattach(lastSeq + 1);
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

	const follow = async (): Promise<CallOutcome> => {
		if ("start" in begin) await Promise.race([channel.start(begin.start), aborted]);
		else {
			const resumed = await query();
			if (resumed) return resumed;
		}
		for (;;) {
			const reading = streamEnded ? parked : (pending ??= frames.next());
			const sleeper = new AbortController();
			const tick = ctx.clock.sleep(ctx.bounds.idleMs / 2, sleeper.signal).then(
				() => "probe" as const,
				() => parked,
			);
			const next = await Promise.race([reading, tick, aborted]);
			sleeper.abort();
			if (next === "probe") {
				const outcome = await probe();
				if (outcome) return outcome;
				continue;
			}
			pending = undefined;
			if (next.done) {
				streamEnded = true;
				const outcome = await query();
				if (outcome) return outcome;
				continue;
			}
			const frame = next.value;
			lastProgress = ctx.clock.now();
			if (frame.t === "provider.call.hooked") {
				if (!row.hooksApplied && lastSeq === 0)
					await store(ledger.recordHooked(row, storedRequestJson(frame.request)));
			} else if (frame.t === "provider.call.event") onEvent(frame.seq, frame.event);
			else return settle(frame);
		}
	};
	try {
		return await follow();
	} finally {
		close(frames);
	}
}
