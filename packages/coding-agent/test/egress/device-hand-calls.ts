/**
 * The hand double's per-call frame log (CK9 tests): frames in seq order per `callId`, live readers that wait for new
 * frames, and the `provider.call.result` reply a hand executor gives for a call it holds (4.3: `running` with the last
 * seq, or `done` with every event and the terminal frame; `hooked` included when the hooks ran).
 */
import type {
	ProviderCallEnd,
	ProviderCallError,
	ProviderCallEvent,
	ProviderCallHooked,
	ProviderCallResultReply,
} from "../../src/core/egress/wire.ts";

export type Frame = ProviderCallHooked | ProviderCallEvent | ProviderCallEnd | ProviderCallError;

interface CallRecord {
	readonly frames: Frame[];
	readonly wake: Set<() => void>;
}

const isTerminal = (frame: Frame | undefined): frame is ProviderCallEnd | ProviderCallError =>
	frame?.t === "provider.call.end" || frame?.t === "provider.call.error";

export interface CallLog {
	has(callId: string): boolean;
	open(callId: string): void;
	drop(callId: string): void;
	append(callId: string, frame: Frame): void;
	framesOf(callId: string): readonly Frame[];
	read(callId: string, fromSeq: number): AsyncGenerator<Frame>;
	reply(callId: string): ProviderCallResultReply;
}

export function createCallLog(): CallLog {
	const calls = new Map<string, CallRecord>();
	const record = (callId: string): CallRecord => {
		const existing = calls.get(callId);
		if (existing) return existing;
		const created: CallRecord = { frames: [], wake: new Set() };
		calls.set(callId, created);
		return created;
	};
	async function* read(callId: string, fromSeq: number): AsyncGenerator<Frame> {
		const call = record(callId);
		let index = 0;
		for (;;) {
			while (index < call.frames.length) {
				const frame = call.frames[index++];
				if (frame && frame.seq >= fromSeq) yield frame;
				if (isTerminal(frame)) return;
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			call.wake.add(resolve);
			await promise;
			call.wake.delete(resolve);
		}
	}
	return {
		has: (callId) => calls.has(callId),
		open: (callId) => void record(callId),
		drop: (callId) => void calls.delete(callId),
		append(callId, frame) {
			const call = record(callId);
			call.frames.push(frame);
			for (const wake of [...call.wake]) wake();
		},
		framesOf: (callId) => calls.get(callId)?.frames ?? [],
		read,
		reply(callId) {
			const call = calls.get(callId);
			if (!call) return { t: "provider.call.result.reply", callId, state: "unknown" };
			const hooked = call.frames.find((frame): frame is ProviderCallHooked => frame.t === "provider.call.hooked");
			const withHooked = hooked ? { hooked } : {};
			const last = call.frames.at(-1);
			if (!isTerminal(last))
				return {
					t: "provider.call.result.reply",
					callId,
					state: "running",
					lastSeq: last?.seq ?? 0,
					...withHooked,
				};
			const events = call.frames.flatMap((frame) => (frame.t === "provider.call.event" ? [frame.event] : []));
			return { t: "provider.call.result.reply", callId, state: "done", events, end: last, ...withHooked };
		},
	};
}

/** Resolves `reached(n)` once `bump` has been called `n` times. */
export function createCounter(): { bump(): void; reached(count: number): Promise<void> } {
	let count = 0;
	const waiters = new Set<{ readonly count: number; readonly wake: () => void }>();
	return {
		bump() {
			count += 1;
			for (const waiter of [...waiters]) {
				if (waiter.count > count) continue;
				waiters.delete(waiter);
				waiter.wake();
			}
		},
		reached(target) {
			if (count >= target) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.add({ count: target, wake: resolve });
			return promise;
		},
	};
}
