/**
 * A hand double for the device route (CK9 tests): one device's `ProviderCallChannel`. It checks every `start` and
 * `result` claim with the real `verifyPlacementClaim`, runs the session's request hooks when `hooks: "enabled"`
 * (emitting `hooked` at seq 0 before any event), executes through a caller-supplied responder, keeps every call's
 * frames until `ack`, and answers `result` queries the way the hand executor does (4.3, 4.5).
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	CLAIM_VERDICT_ERRORS,
	type ClaimClock,
	type ClaimTrust,
	verifyPlacementClaim,
} from "../../src/core/egress/placement-claim.ts";
import type {
	HandPresence,
	HandSessionAdvertisement,
	ProviderCallAck,
	ProviderCallCancel,
	ProviderCallChannel,
	ProviderCallErrorCode,
	ProviderCallRequest,
	ProviderCallResultQuery,
	ProviderCallResultReply,
	ProviderCallStart,
} from "../../src/core/egress/wire.ts";
import type { Registry } from "./claim-fixture.ts";
import { createCallLog, createCounter, type Frame } from "./device-hand-calls.ts";

export type Responder = (
	start: ProviderCallStart,
	request: ProviderCallRequest,
) => readonly AssistantMessageEvent[] | Promise<readonly AssistantMessageEvent[]>;

/** What the next `start` does instead of answering normally. */
export type StartFault =
	| { readonly kind: "error"; readonly code: ProviderCallErrorCode; readonly retryable?: boolean }
	| { readonly kind: "hang-after-hooks" }
	| { readonly kind: "hang-after-hooked" }
	| { readonly kind: "hang-after-events"; readonly events: number };

export interface HandDouble extends ProviderCallChannel {
	readonly deviceId: string;
	/** The registry whose claims this hand trusts; a brain talking to it signs with this one. */
	readonly registry: Registry;
	readonly starts: ProviderCallStart[];
	readonly cancels: ProviderCallCancel[];
	readonly acks: string[];
	readonly resultQueries: string[];
	readonly hookRuns: number;
	readonly executions: number;
	fault(next: StartFault): void;
	/** The hand loses every record of `callId` (restart without retention): `result` answers `unknown`. */
	forget(callId: string): void;
	/** Appends the rest of a hung call's answer, as a hand that recovers would. */
	finish(callId: string): Promise<void>;
	framesOf(callId: string): readonly Frame[];
	/** Resolves once `count` starts have been fully handled (executed, hung or refused). */
	started(count: number): Promise<void>;
}

export interface HandDoubleOptions {
	readonly deviceId: string;
	readonly registry: Registry;
	readonly trust: ClaimTrust;
	readonly clock: ClaimClock;
	readonly respond: Responder;
	/** The session's request hooks as the hand runs them; absent means the provider has none. */
	readonly requestHook?: (request: ProviderCallRequest) => ProviderCallRequest;
}

const terminalEvent = (events: readonly AssistantMessageEvent[]): AssistantMessageEvent | undefined => events.at(-1);

export function createHandDouble(options: HandDoubleOptions): HandDouble {
	const calls = createCallLog();
	const starts: ProviderCallStart[] = [];
	const cancels: ProviderCallCancel[] = [];
	const acks: string[] = [];
	const resultQueries: string[] = [];
	const pendingFaults: StartFault[] = [];
	const refusedOnly = new Set<string>();
	const resumable = new Map<
		string,
		{
			readonly start: ProviderCallStart;
			readonly request: ProviderCallRequest;
			readonly executed: boolean;
			readonly events?: readonly AssistantMessageEvent[];
		}
	>();
	const handled = createCounter();
	let hookRuns = 0;
	let executions = 0;

	const append = calls.append;
	const refuse = (callId: string, code: ProviderCallErrorCode, retryable: boolean, message: string): void => {
		refusedOnly.add(callId);
		append(callId, { t: "provider.call.error", callId, seq: 1, code, retryable, message });
	};

	const emitAnswer = (
		start: ProviderCallStart,
		events: readonly AssistantMessageEvent[],
		fromEvent: number,
		stopAfter?: number,
	): void => {
		const end = stopAfter === undefined ? events.length : Math.min(events.length, fromEvent + stopAfter);
		for (let index = fromEvent; index < end; index++) {
			const event = events[index];
			if (event) append(start.callId, { t: "provider.call.event", callId: start.callId, seq: index + 1, event });
		}
		if (stopAfter !== undefined && end < events.length) return;
		const last = terminalEvent(events);
		const message = last?.type === "done" ? last.message : last?.type === "error" ? last.error : undefined;
		if (!message) throw new Error("responder returned no terminal event");
		append(start.callId, {
			t: "provider.call.end",
			callId: start.callId,
			seq: events.length + 1,
			usage: message.usage,
			stopReason: message.stopReason,
		});
	};

	const execute = async (start: ProviderCallStart): Promise<void> => {
		const fault = pendingFaults.shift();
		if (fault?.kind === "error") {
			refuse(start.callId, fault.code, fault.retryable ?? false, `refused: ${fault.code}`);
			return;
		}
		let request = start.request;
		if (start.hooks === "enabled" && options.requestHook) {
			hookRuns += 1;
			request = options.requestHook(request);
			if (fault?.kind === "hang-after-hooks") return;
			append(start.callId, { t: "provider.call.hooked", callId: start.callId, seq: 0, request });
			if (fault?.kind === "hang-after-hooked") {
				resumable.set(start.callId, { start, request, executed: false });
				return;
			}
		}
		executions += 1;
		const events = await options.respond(start, request);
		const stopAfter = fault?.kind === "hang-after-events" ? fault.events : undefined;
		if (stopAfter !== undefined) resumable.set(start.callId, { start, request, executed: true, events });
		emitAnswer(start, events, 0, stopAfter);
	};

	const handleStart = async (msg: ProviderCallStart): Promise<void> => {
		const verdict = await verifyPlacementClaim(msg.claim, options.trust, options.clock);
		if (verdict !== "valid") {
			const { code, retryable } = CLAIM_VERDICT_ERRORS[verdict];
			calls.drop(msg.callId);
			refuse(msg.callId, code, retryable, `claim ${verdict}`);
			return;
		}
		if (refusedOnly.delete(msg.callId)) calls.drop(msg.callId);
		if (calls.has(msg.callId)) return;
		calls.open(msg.callId);
		await execute(msg);
	};

	return {
		deviceId: options.deviceId,
		registry: options.registry,
		starts,
		cancels,
		acks,
		resultQueries,
		get hookRuns() {
			return hookRuns;
		},
		get executions() {
			return executions;
		},
		fault: (next) => {
			pendingFaults.push(next);
		},
		forget: (callId) => {
			calls.drop(callId);
			resumable.delete(callId);
		},
		finish: async (callId) => {
			const hung = resumable.get(callId);
			if (!hung) throw new Error(`call ${callId} is not hung`);
			resumable.delete(callId);
			const done = calls.framesOf(callId).filter((frame) => frame.t === "provider.call.event").length;
			if (!hung.executed) executions += 1;
			emitAnswer(hung.start, hung.events ?? (await options.respond(hung.start, hung.request)), done);
		},
		framesOf: calls.framesOf,
		started: handled.reached,
		async start(msg: ProviderCallStart) {
			starts.push(msg);
			try {
				await handleStart(msg);
			} finally {
				handled.bump();
			}
		},

		async result(msg: ProviderCallResultQuery): Promise<ProviderCallResultReply> {
			resultQueries.push(msg.callId);
			const verdict = await verifyPlacementClaim(msg.claim, options.trust, options.clock);
			if (verdict !== "valid") return { t: "provider.call.result.reply", callId: msg.callId, state: "unknown" };
			return calls.reply(msg.callId);
		},
		async ack(msg: ProviderCallAck) {
			acks.push(msg.callId);
			calls.drop(msg.callId);
		},
		async cancel(msg: ProviderCallCancel) {
			cancels.push(msg);
		},
		events: (callId, fromSeq) => calls.read(callId, fromSeq),
		presence: (async function* (): AsyncGenerator<HandPresence> {})(),
		hooks: (async function* (): AsyncGenerator<HandSessionAdvertisement> {})(),
	};
}
