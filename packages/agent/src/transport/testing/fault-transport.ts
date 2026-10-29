import type { ManualTimers } from "../../durable/testing/manual-timers.ts";
import type { CarrierLink } from "../in-process-carrier.ts";
import type { CarrierConnection, CarrierSide } from "../transport.ts";
import type { CarrierFault } from "./transport-harness.ts";

/**
 * The five QX2 fault profiles as test parameters (not product settings). The plan fixes their shape; the numbers here are
 * this suite's until M0 records final values in the gate's fault-profiles.json.
 */
const PROFILES = {
	slow: { perTick: 1, tickMs: 10 },
	lossy: { lossRate: 0.2, seed: 7 },
	laggy: { latencyMs: 40, jitterMs: 60, seed: 11 },
	flap: { upMs: 100, downMs: 60, cycles: 8 },
	"drop-reattach": { everyMessages: 9, reattachMs: 30, repetitions: 6 },
} as const;

export type FaultProfileName = keyof typeof PROFILES;
export const FAULT_PROFILE_NAMES: readonly FaultProfileName[] = ["slow", "lossy", "laggy", "flap", "drop-reattach"];

/** How often the profile actually acted, so a case can refuse to pass on a fault that never happened. */
export interface FaultStats {
	refused: number;
	lost: number;
	reordered: number;
	drops: number;
}

const mulberry32 = (seed: number) => {
	let state = seed >>> 0;
	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

type Send = (inner: CarrierConnection, side: CarrierSide, message: unknown, live: () => boolean) => boolean;

function wrapWith(send: Send): (side: CarrierSide) => CarrierSide {
	return (side) => {
		let current: CarrierConnection | undefined;
		return {
			attached: (connection) => {
				current = connection;
				const live = () => current === connection;
				side.attached({
					send: (message) => send(connection, side, message, live),
					close: () => connection.close(),
				});
			},
			message: (message) => side.message(message),
			writable: () => side.writable(),
			detached: () => {
				current = undefined;
				side.detached();
			},
		};
	};
}

function slow(timers: ManualTimers, stats: FaultStats): Send {
	const { perTick, tickMs } = PROFILES.slow;
	const used = new WeakMap<CarrierSide, { tick: number; count: number; waiting: boolean }>();
	return (inner, side, message, live) => {
		const tick = Math.floor(timers.now() / tickMs);
		const state = used.get(side) ?? { tick, count: 0, waiting: false };
		if (state.tick !== tick) Object.assign(state, { tick, count: 0 });
		used.set(side, state);
		if (state.count < perTick) {
			state.count += 1;
			return inner.send(message);
		}
		stats.refused += 1;
		if (!state.waiting) {
			state.waiting = true;
			timers.setTimer(
				() => {
					state.waiting = false;
					if (live()) side.writable();
				},
				(tick + 1) * tickMs - timers.now(),
			);
		}
		return false;
	};
}

function lossy(stats: FaultStats): Send {
	const random = mulberry32(PROFILES.lossy.seed);
	return (inner, _side, message) => {
		if (random() < PROFILES.lossy.lossRate) {
			stats.lost += 1;
			return true;
		}
		return inner.send(message);
	};
}

function laggy(timers: ManualTimers, stats: FaultStats): Send {
	const { latencyMs, jitterMs, seed } = PROFILES.laggy;
	const random = mulberry32(seed);
	const order = new WeakMap<CarrierSide, { sent: number; highest: number }>();
	return (inner, side, message, live) => {
		const state = order.get(side) ?? { sent: 0, highest: 0 };
		order.set(side, state);
		state.sent += 1;
		const index = state.sent;
		timers.setTimer(
			() => {
				if (!live()) return;
				if (index < state.highest) stats.reordered += 1;
				state.highest = Math.max(state.highest, index);
				inner.send(message);
			},
			latencyMs + Math.floor(random() * jitterMs),
		);
		return true;
	};
}

function flap(timers: ManualTimers, stats: FaultStats, link: CarrierLink): void {
	const { upMs, downMs, cycles } = PROFILES.flap;
	for (let cycle = 0; cycle < cycles; cycle++) {
		const start = timers.now() + cycle * (upMs + downMs);
		timers.setTimer(
			() => {
				stats.drops += 1;
				link.drop();
			},
			start + upMs - timers.now(),
		);
		timers.setTimer(() => link.connect(), start + upMs + downMs - timers.now());
	}
}

/** Builds one profile's fault for the link a case opens. */
export function createCarrierFault(name: FaultProfileName, stats: FaultStats): (timers: ManualTimers) => CarrierFault {
	return (timers) => {
		let link: CarrierLink | undefined;
		const passThrough: Send = (inner, _side, message) => inner.send(message);
		let sent = 0;
		const dropReattach: Send = (inner, _side, message) => {
			const { everyMessages, reattachMs, repetitions } = PROFILES["drop-reattach"];
			sent += 1;
			if (sent % everyMessages === 0 && stats.drops < repetitions && link !== undefined) {
				const target = link;
				stats.drops += 1;
				timers.setTimer(() => target.drop(), 0);
				timers.setTimer(() => target.connect(), reattachMs);
			}
			return inner.send(message);
		};
		const sends: Record<FaultProfileName, Send> = {
			slow: slow(timers, stats),
			lossy: lossy(stats),
			laggy: laggy(timers, stats),
			flap: passThrough,
			"drop-reattach": dropReattach,
		};
		return {
			wrap: wrapWith(sends[name]),
			start(started) {
				link = started;
				if (name === "flap") flap(timers, stats, started);
			},
		};
	};
}
