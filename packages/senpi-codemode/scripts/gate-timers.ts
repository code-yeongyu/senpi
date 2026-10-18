import { createRequire, syncBuiltinESMExports } from "node:module";
import timers from "node:timers";
import type { TimerOptions } from "node:timers";
import promiseTimers from "node:timers/promises";
import { GateInputError } from "./gate-input-error.ts";

/**
 * Timer functions are proxied once, when this module is evaluated. The gate
 * runtime imports it first, so no module of the kernel graph can capture the
 * unobserved setTimeout/setInterval/setImmediate at its own load time.
 * Recording happens only inside an open observation window.
 */
type OwnedTimer = { readonly live: () => boolean; readonly site: string };

const windows = new Set<OwnedTimer[]>();
let invoking = false;

function creationSite(kind: string): string {
	const frames = (new Error().stack ?? "").split("\n").slice(1).map((frame) => frame.trim());
	const site = frames.find((frame) => /:\d+:\d+\)?$/.test(frame) && !frame.includes("gate-timers.ts")) ?? "unknown";
	return `${kind} ${site}`;
}

function record(entry: OwnedTimer): void {
	for (const owned of windows) owned.push(entry);
}

function observeTimer<T extends (...args: never[]) => unknown>(kind: string, original: T): T {
	return new Proxy(original, {
		apply(target, receiver, args) {
			const timer: unknown = Reflect.apply(target, receiver, args);
			if (windows.size === 0 || invoking) return timer;
			if (typeof timer !== "object" || timer === null || typeof Reflect.get(timer, "_destroyed") !== "boolean")
				throw new GateInputError(`${kind} observation`);
			record({ live: () => Reflect.get(timer, "_destroyed") !== true, site: creationSite(kind) });
			return timer;
		},
	});
}

function observePromise<T extends (...args: never[]) => Promise<unknown>>(kind: string, original: T): T {
	return new Proxy(original, {
		apply(target, receiver, args) {
			if (invoking || windows.size === 0) return Reflect.apply(target, receiver, args);
			let pending: unknown;
			invoking = true;
			try {
				pending = Reflect.apply(target, receiver, args);
			} finally {
				invoking = false;
			}
			if (!(pending instanceof Promise)) throw new GateInputError(`${kind} observation`);
			let live = true;
			record({ live: () => live, site: creationSite(kind) });
			return pending.then(
				(value) => { live = false; return value; },
				(error: unknown) => { live = false; throw error; },
			);
		},
	});
}

const originalInterval = promiseTimers.setInterval;
const observedInterval: typeof originalInterval = <T>(delay?: number, value?: T, options?: TimerOptions) => {
	const iterator = originalInterval(delay, value, options);
	const site = creationSite("node:timers/promises.setInterval");
	let started = false;
	let live = false;
	for (const method of ["next", "return", "throw"] as const) {
		const original = iterator[method];
		if (!original) continue;
		Object.defineProperty(iterator, method, { configurable: true, value: new Proxy(original, {
			apply(target, receiver, inputs) {
				if (method === "next" && !started) {
					started = true;
					live = true;
					record({ live: () => live && options?.signal?.aborted !== true, site });
				}
				let pending: unknown;
				invoking = true;
				try {
					pending = Reflect.apply(target, receiver, inputs);
				} finally {
					invoking = false;
				}
				if (!(pending instanceof Promise)) throw new GateInputError("interval iteration observation");
				return pending.then(
					(result: IteratorResult<unknown>) => {
						// Bun's native return() resolves to {}, but still retires the interval.
						if (method === "return" || result.done) live = false;
						return result;
					},
					(error: unknown) => { live = false; throw error; },
				);
			},
		}) });
	}
	return iterator;
};

const observers = {
	setTimeout: observeTimer("setTimeout", globalThis.setTimeout),
	setInterval: observeTimer("setInterval", globalThis.setInterval),
	setImmediate: observeTimer("setImmediate", globalThis.setImmediate),
};
Object.assign(globalThis, observers);
Object.assign(timers, observers);
Object.assign(promiseTimers, {
	setTimeout: observePromise("node:timers/promises.setTimeout", promiseTimers.setTimeout),
	setImmediate: observePromise("node:timers/promises.setImmediate", promiseTimers.setImmediate),
	setInterval: observedInterval,
});
Object.assign(promiseTimers.scheduler, {
	wait: observePromise("scheduler.wait", promiseTimers.scheduler.wait),
	yield: observePromise("scheduler.yield", promiseTimers.scheduler.yield),
});
AbortSignal.timeout = new Proxy(AbortSignal.timeout, {
	apply(target, receiver, args) {
		const signal: AbortSignal = Reflect.apply(target, receiver, args);
		record({ live: () => !signal.aborted, site: creationSite("AbortSignal.timeout") });
		return signal;
	},
});
syncBuiltinESMExports();
if (process.versions.bun !== undefined) {
	// Bun does not refresh builtin ESM bindings through syncBuiltinESMExports.
	// Its module replacement API installs these real, delegating observers in
	// both import spellings; no timer implementation is faked.
	const { mock }: { mock: { module(id: string, factory: () => object): void } } = createRequire(import.meta.url)("bun:test");
	for (const id of ["timers", "node:timers"]) mock.module(id, () => ({ ...timers, default: timers }));
	for (const id of ["timers/promises", "node:timers/promises"])
		mock.module(id, () => ({ ...promiseTimers, default: promiseTimers }));
}

export function observeTimers() {
	const owned: OwnedTimer[] = [];
	windows.add(owned);
	// Timers have no close event. Bun and Node both set `_destroyed` only after
	// clear/close or a fired one-shot, so neither unref() nor refresh() hides one.
	const live = () => owned.filter((entry) => entry.live());
	return {
		count: () => live().length,
		sites: () => live().map((entry) => entry.site),
		stop: () => { windows.delete(owned); },
	};
}
