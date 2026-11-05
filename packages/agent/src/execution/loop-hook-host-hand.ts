import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import type { HandEpochFence } from "./remote-epoch.ts";
import type { Transport, TransportFrame } from "../transport/transport.ts";
import {
	decodeLoopHookMessage,
	encodeLoopHookMessage,
	type LoopHookCall,
	type LoopHookFailed,
	type LoopHookMessage,
	type LoopHookRefused,
	type LoopHookReply,
} from "./loop-hook-host-protocol.ts";

/** Runs the user's hooks for one loop event on this machine and returns what they produced. */
export type LoopHookRunner = (event: string, payload: JsonValue) => Promise<JsonValue>;

/** The points of one hook call on the hand, in order; a kill-point probe may stop the process at any of them. */
export type LoopHookPoint = "received" | "started" | "ran" | "replied";

/** What the hand knows of one call it admitted: who presented it, which process started it, and its answer once run. */
export interface LoopHookRecord {
	readonly sender: string;
	readonly starter: string;
	readonly answer?: LoopHookReply | LoopHookFailed;
}

export interface LoopHookHandOptions {
	/**
	 * The user machine's end of the link to the loop host. It must outlive this process (the machine's long-lived link
	 * endpoint): a `started` still unacknowledged when the endpoint dies is lost, and the loop host then sends the call
	 * again to the replacement process, which runs the hooks a second time.
	 */
	readonly transport: Transport;
	readonly lane: string;
	readonly run: LoopHookRunner;
	/**
	 * The hand's epoch fence (S35) and the authenticated sender of this link (senpi#5916): an epoch-bearing call runs only
	 * while the tool scope its payload names has a floor and the fence admits the call's epoch from that sender.
	 */
	readonly fence?: HandEpochFence;
	readonly sender?: string;
	/** The scope's current owner (the embedder's placement record): it may read any known call's answer (senpi#5916). */
	readonly ownerOf?: (scope: string) => string | undefined;
	/** Where call records live; one that outlives the process lets a replacement answer `hook.restarted`. Default: per process. */
	readonly records?: Map<string, LoopHookRecord>;
	/** This process's identity; a new one per process start. */
	readonly instance?: string;
	/** Test-only probe: throwing here stops this process at that point, as a kill does. */
	readonly onPoint?: (point: LoopHookPoint, callId: string) => void;
	readonly onFault?: (error: unknown) => void;
}

export interface LoopHookHand {
	/** Resolves once this process announced itself to the loop host. */
	readonly ready: Promise<void>;
	close(): void;
}

/**
 * The user machine's side of the loop-hook link (S33): runs each hook call once per process and answers a repeated call
 * from its stored answer. It announces itself first, and says `started` before any hook runs, so the loop host can tell
 * a call this process never began (safe to send again) from one it may have run (never sent again).
 */
const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function scopeOf(call: LoopHookCall): string | undefined {
	const scope = isJsonObject(call.payload) ? call.payload.scope : undefined;
	return isJsonObject(scope) && typeof scope.id === "string" ? scope.id : undefined;
}

export function serveLoopHooks(options: LoopHookHandOptions): LoopHookHand {
	const { transport, lane } = options;
	const instance = options.instance ?? crypto.randomUUID();
	const records = options.records ?? new Map<string, LoopHookRecord>();
	const sender = options.sender ?? "";
	let dead = false;

	const send = (message: LoopHookMessage): Promise<void> => transport.send(lane, encodeLoopHookMessage(message));
	const point = (at: LoopHookPoint, callId: string): void => {
		if (dead) throw new Error("this hand process was stopped");
		try {
			options.onPoint?.(at, callId);
		} catch (error) {
			dead = true;
			throw error;
		}
	};

	/** The fence's verdict on an epoch-bearing call; `taken`: the id is known to another sender, so an admitted call is refused too. */
	const refusalFor = (call: LoopHookCall, taken: boolean): LoopHookRefused | undefined => {
		const { fence } = options;
		const { callId, epoch } = call;
		if (fence === undefined || epoch === undefined) return undefined;
		const scopeId = scopeOf(call);
		const floor = scopeId === undefined ? undefined : fence.floorOf(scopeId);
		if (scopeId === undefined || floor === undefined)
			return { kind: "hook.refused", callId, reason: "floor_missing", epoch };
		if (!fence.admits(scopeId, epoch, sender))
			return { kind: "hook.refused", callId, reason: "epoch_fenced", epoch, floor };
		return taken ? { kind: "hook.refused", callId, reason: "callId_taken", epoch, floor } : undefined;
	};

	const replay = async (record: LoopHookRecord, callId: string): Promise<void> => {
		if (record.answer !== undefined) await send(record.answer);
		else if (record.starter !== instance) await send({ kind: "hook.restarted", callId, instance });
	};

	// A known call is replayed before the fence, so a re-send after a floor rise still gets its answer, but only to the
	// sender that presented it or the scope's owner: anyone else falls through to the fence and is never answered.
	const serveKnown = async (call: LoopHookCall, record: LoopHookRecord): Promise<void> => {
		const scopeId = scopeOf(call);
		const owner = scopeId === undefined ? undefined : options.ownerOf?.(scopeId);
		if (record.sender === sender || owner === sender) return replay(record, call.callId);
		const refused = refusalFor(call, true);
		return refused === undefined ? replay(record, call.callId) : send(refused);
	};

	const serve = async (call: LoopHookCall): Promise<void> => {
		const known = records.get(call.callId);
		if (known !== undefined) return serveKnown(call, known);
		const refused = refusalFor(call, false);
		if (refused !== undefined) return send(refused);
		point("received", call.callId);
		const record: LoopHookRecord = { sender, starter: instance };
		records.set(call.callId, record);
		await send({ kind: "hook.started", callId: call.callId, instance });
		point("started", call.callId);
		let answer: LoopHookReply | LoopHookFailed;
		try {
			answer = { kind: "hook.reply", callId: call.callId, result: await options.run(call.event, call.payload) };
		} catch (error) {
			answer = {
				kind: "hook.failed",
				callId: call.callId,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		point("ran", call.callId);
		records.set(call.callId, { ...record, answer });
		await send(answer);
		point("replied", call.callId);
	};

	transport.onFrame(async (frame: TransportFrame) => {
		if (dead) return;
		const message = decodeLoopHookMessage(frame.payload);
		if (message?.kind !== "hook.call") return;
		try {
			await serve(message);
		} catch (error) {
			options.onFault?.(error);
		}
	});

	return {
		ready: send({ kind: "hook.hello", instance }),
		close() {
			dead = true;
		},
	};
}
