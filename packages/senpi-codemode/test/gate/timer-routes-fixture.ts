import "../../scripts/gate-timers.ts";
import { once } from "node:events";
import * as timers from "node:timers";
import { setInterval as namedInterval } from "node:timers";
import promises, { setInterval as promiseInterval, scheduler } from "node:timers/promises";
import { observeTimers } from "../../scripts/gate-timers.ts";

const watchdog = setTimeout(() => process.exit(2), 180_000);
const reports: { route: string; live: number; sites: string[]; retired: number }[] = [];

async function probe(route: string, start: () => Promise<() => Promise<void>>) {
	const window = observeTimers();
	try {
		const retire = await start();
		const live = window.count();
		const sites = window.sites();
		await retire();
		reports.push({ route, live, sites, retired: window.count() });
	} finally {
		window.stop();
	}
}

function cancellation(pending: Promise<unknown>, controller: AbortController) {
	const settled = pending.catch((error: unknown) => {
		if (!(error instanceof Error) || error.name !== "AbortError") throw error;
	});
	return async () => {
		controller.abort();
		await settled;
	};
}

try {
	for (const [route, create] of [
		["global interval", globalThis.setInterval],
		["named interval", namedInterval],
		["namespace interval", timers.setInterval],
	] as const) {
		await probe(route, async () => {
			const ticked = Promise.withResolvers<void>();
			const timer = create(() => ticked.resolve(), 1).unref();
			await ticked.promise;
			return async () => {
				clearInterval(timer);
			};
		});
	}
	await probe("global timeout", async () => {
		const timer = setTimeout(() => undefined, 60_000).unref();
		return async () => {
			clearTimeout(Number(timer));
		};
	});
	await probe("global immediate", async () => {
		const timer = setImmediate(() => undefined);
		return async () => {
			clearImmediate(timer);
		};
	});
	await probe("promise timeout", async () => {
		const controller = new AbortController();
		return cancellation(
			promises.setTimeout(60_000, undefined, { signal: controller.signal, ref: false }),
			controller,
		);
	});
	await probe("promise immediate", async () => {
		const controller = new AbortController();
		return cancellation(promises.setImmediate(undefined, { signal: controller.signal, ref: false }), controller);
	});
	await probe("scheduler wait", async () => {
		const controller = new AbortController();
		return cancellation(scheduler.wait(60_000, { signal: controller.signal }), controller);
	});
	await probe("scheduler yield", async () => {
		const pending = scheduler.yield();
		return async () => {
			await pending;
		};
	});
	await probe("promise interval", async () => {
		const controller = new AbortController();
		const iterator = promiseInterval(1, undefined, { signal: controller.signal, ref: false });
		await iterator.next();
		const retire = cancellation(iterator.next(), controller);
		return async () => {
			await retire();
			if (!iterator.return) throw new TypeError("Timer iterator has no return method");
			await iterator.return();
		};
	});
	await probe("returned interval", async () => {
		const iterator = promiseInterval(1);
		await iterator.next();
		return async () => {
			if (!iterator.return) throw new TypeError("Timer iterator has no return method");
			await iterator.return();
		};
	});
	await probe("abort poll", async () => {
		let running = true;
		let signal = AbortSignal.timeout(1);
		const ticked = Promise.withResolvers<void>();
		const poll = () => {
			if (!running) return;
			signal = AbortSignal.timeout(1);
			signal.addEventListener("abort", poll, { once: true });
			ticked.resolve();
		};
		signal.addEventListener("abort", poll, { once: true });
		await ticked.promise;
		return async () => {
			running = false;
			if (!signal.aborted) await once(signal, "abort");
		};
	});
	console.log(JSON.stringify(reports));
} finally {
	clearTimeout(watchdog);
}
