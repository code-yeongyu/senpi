/**
 * The hand double's per-call frame log (CK9 tests): frames in seq order per `callId`, live readers that wait for new
 * frames, and the `provider.call.result` reply a hand executor gives for a call it holds (4.3: `running` with the last
 * seq, or `done` with every event and the terminal frame; `hooked` included when the hooks ran). Transport faults: a
 * `cut` reader ends as soon as it has no frame to give (the stream closed while the call runs on), a `stall`ed reader
 * never delivers again until `return()`; `openReaders` counts readers neither finished nor returned.
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

export type ReaderFault = "none" | "cut" | "stall";

const isTerminal = (frame: Frame | undefined): frame is ProviderCallEnd | ProviderCallError =>
	frame?.t === "provider.call.end" || frame?.t === "provider.call.error";

export interface CallLog {
	has(callId: string): boolean;
	open(callId: string): void;
	drop(callId: string): void;
	append(callId: string, frame: Frame): void;
	framesOf(callId: string): readonly Frame[];
	read(callId: string, fromSeq: number): AsyncIterableIterator<Frame>;
	reply(callId: string): ProviderCallResultReply;
	/** Applies to readers opened from now on. */
	readerFault(fault: ReaderFault): void;
	openReaders(): number;
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
	let fault: ReaderFault = "none";
	const open = new Set<object>();
	function read(callId: string, fromSeq: number): AsyncIterableIterator<Frame> {
		let call: CallRecord | undefined;
		const mode = fault;
		let index = 0;
		let finished = false;
		const closed = Promise.withResolvers<void>();
		const finish = (): IteratorResult<Frame> => {
			finished = true;
			open.delete(reader);
			closed.resolve();
			return { done: true, value: undefined };
		};
		const reader: AsyncIterableIterator<Frame> = {
			[Symbol.asyncIterator]: () => reader,
			async next() {
				const log = (call ??= record(callId));
				for (;;) {
					if (finished) return { done: true, value: undefined };
					if (mode === "stall") {
						await closed.promise;
						continue;
					}
					const frame = log.frames[index];
					if (frame) {
						index += 1;
						if (isTerminal(frame)) finished = true;
						if (finished) open.delete(reader);
						if (frame.seq >= fromSeq) return { done: false, value: frame };
						continue;
					}
					if (mode === "cut") return finish();
					const { promise, resolve } = Promise.withResolvers<void>();
					log.wake.add(resolve);
					await Promise.race([promise, closed.promise]);
					log.wake.delete(resolve);
				}
			},
			async return() {
				return finish();
			},
		};
		open.add(reader);
		return reader;
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
		readerFault: (next) => {
			fault = next;
		},
		openReaders: () => open.size,
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
