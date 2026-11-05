/**
 * A headless engine's view of which machines its sessions depend on are reachable (C2, K7; senpi#5652).
 *
 * The owning machine (the placement) offline pauses every session before its next provider request; a hand offline
 * pauses the tool calls of the sessions that run on it, while other sessions keep going. Each pause is a durable
 * record (presence-ledger.ts); reconnect resumes it exactly once, and a restart recovers the open pauses.
 */
import type { RpcSessionPresence } from "../rpc/rpc-host-response-types.ts";
import type { PresenceLedger, PresencePause, PresenceRole } from "./presence-ledger.ts";

/** What a step needs: a provider request needs the placement; a tool batch also needs the session's hands. */
export type PresenceWork = "request" | "tools";

export interface HeadlessPresence {
	readonly placement: string;
	/** Registers an open session and the hand machines its tool calls run on (empty for a fused session). */
	track(sessionId: string, hands: readonly string[]): Promise<void>;
	machineOffline(machine: string): Promise<void>;
	machineOnline(machine: string): Promise<void>;
	view(sessionId: string): RpcSessionPresence;
	/** Resolves once nothing `work` depends on is paused, or when `signal` aborts. */
	ready(sessionId: string, work: PresenceWork, signal?: AbortSignal): Promise<void>;
	subscribe(listener: (sessionId: string) => void): () => void;
}

export async function openHeadlessPresence(options: {
	readonly ledger: PresenceLedger;
	readonly placement: string;
}): Promise<HeadlessPresence> {
	const { ledger, placement } = options;
	const hands = new Map<string, readonly string[]>();
	const pauses = new Map<string, Map<string, PresencePause>>();
	const held = new Map<string, number>();
	const offline = new Set<string>();
	const listeners = new Set<(sessionId: string) => void>();
	let changed = Promise.withResolvers<void>();
	let serial: Promise<unknown> = Promise.resolve();

	const notify = (sessionId: string): void => {
		changed.resolve();
		changed = Promise.withResolvers<void>();
		for (const listener of [...listeners]) listener(sessionId);
	};
	const remember = (pause: PresencePause): void => {
		const open = pauses.get(pause.sessionId) ?? new Map<string, PresencePause>();
		open.set(pause.machine, pause);
		pauses.set(pause.sessionId, open);
	};
	for (const pause of await ledger.openPauses()) {
		remember(pause);
		offline.add(pause.machine);
	}
	/** Presence operations run one at a time, so the in-memory view follows the durable order. */
	const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
		const run = serial.then(operation);
		serial = run.catch(() => undefined);
		return run;
	};
	const roleOf = (sessionId: string, machine: string): PresenceRole | undefined => {
		if (machine === placement) return "owner";
		return hands.get(sessionId)?.includes(machine) === true ? "hand" : undefined;
	};
	const pauseOn = async (sessionId: string, machine: string): Promise<void> => {
		const role = roleOf(sessionId, machine);
		if (role === undefined || pauses.get(sessionId)?.has(machine) === true) return;
		remember(await ledger.pause(sessionId, machine, role));
		notify(sessionId);
	};
	const blocked = (sessionId: string, work: PresenceWork): boolean => {
		const open = pauses.get(sessionId);
		if (open === undefined) return false;
		return work === "tools" ? open.size > 0 : open.has(placement);
	};
	const adjustHeld = (sessionId: string, delta: number): void => {
		held.set(sessionId, (held.get(sessionId) ?? 0) + delta);
		notify(sessionId);
	};

	return {
		placement,
		track: (sessionId, sessionHands) =>
			serialized(async () => {
				hands.set(sessionId, [...sessionHands]);
				for (const machine of offline) await pauseOn(sessionId, machine);
			}),
		machineOffline: (machine) =>
			serialized(async () => {
				offline.add(machine);
				for (const sessionId of hands.keys()) await pauseOn(sessionId, machine);
			}),
		machineOnline: (machine) =>
			serialized(async () => {
				offline.delete(machine);
				for (const [sessionId, open] of pauses) {
					if (!open.has(machine)) continue;
					await ledger.resume(sessionId, machine);
					open.delete(machine);
					if (open.size === 0) pauses.delete(sessionId);
					notify(sessionId);
				}
			}),
		view: (sessionId) => {
			const open = [...(pauses.get(sessionId)?.values() ?? [])];
			return {
				placement,
				state: pauses.get(sessionId)?.has(placement) === true ? "offline" : "online",
				paused: open.length > 0,
				waitingOn: open
					.map(({ machine, role }) => ({ machine, role }))
					.sort((a, b) => a.machine.localeCompare(b.machine)),
				held: held.get(sessionId) ?? 0,
			};
		},
		ready: async (sessionId, work, signal) => {
			if (!blocked(sessionId, work) || signal?.aborted === true) return;
			adjustHeld(sessionId, 1);
			const aborted = Promise.withResolvers<void>();
			let stopped = false;
			const onAbort = (): void => {
				stopped = true;
				aborted.resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				while (!stopped && blocked(sessionId, work)) await Promise.race([changed.promise, aborted.promise]);
			} finally {
				signal?.removeEventListener("abort", onAbort);
				adjustHeld(sessionId, -1);
			}
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
