import { describe, expect, it } from "vitest";
import { createObserverLink, type ObserverSocket } from "../../../src/modes/rpc/observer-link.ts";

function fakeClock() {
	let now = 0;
	const pending: Array<{ run: () => void; at: number; cancelled: boolean }> = [];
	return {
		now: () => now,
		setTimer: (run: () => void, ms: number) => {
			const entry = { run, at: now + ms, cancelled: false };
			pending.push(entry);
			return {
				cancel: () => {
					entry.cancelled = true;
				},
			};
		},
		pendingCount: () => pending.filter((entry) => !entry.cancelled && entry.at > now).length,
		async advance(ms: number): Promise<void> {
			now += ms;
			for (const entry of [...pending]) {
				if (entry.cancelled || entry.at > now) continue;
				pending.splice(pending.indexOf(entry), 1);
				entry.run();
				await Promise.resolve();
				await Promise.resolve();
			}
		},
	};
}

function openableSocket(): { socket: ObserverSocket; lose: () => void } {
	let handler: (() => void) | undefined;
	return {
		socket: {
			onLost: (next) => {
				handler = next;
			},
		},
		lose: () => handler?.(),
	};
}

describe("issue 1979: the observer reconnect chain", () => {
	it("keeps retrying while reconnects fail, so an unhealthy observer is not permanent", async () => {
		// given: a link that connected once and will fail every reconnect after that
		const clock = fakeClock();
		const first = openableSocket();
		let attempt = 0;
		const link = createObserverLink({
			open: async () => {
				attempt += 1;
				if (attempt === 1) return first.socket;
				throw new Error(`reconnect ${attempt} refused`);
			},
			settled: () => false,
			retryDelayMs: 250,
			now: clock.now,
			setTimer: clock.setTimer,
		});
		await link.open();
		expect(link.healthy()).toBe(true);

		// when: the connection drops and several reconnect attempts fail in a row
		first.lose();
		expect(link.healthy()).toBe(false);
		await clock.advance(250);
		await clock.advance(250);
		await clock.advance(250);

		// then: the chain is still trying rather than having given up after the first failure
		expect(attempt).toBeGreaterThan(2);
		expect(clock.pendingCount()).toBe(1);
	});

	it("reports how long it has been unhealthy so the caller can bound unknown activity", async () => {
		// given: a link whose connection drops at a known time
		const clock = fakeClock();
		const first = openableSocket();
		const link = createObserverLink({
			open: async () => first.socket,
			settled: () => false,
			retryDelayMs: 250,
			now: clock.now,
			setTimer: clock.setTimer,
		});
		await link.open();
		expect(link.unhealthySince()).toBeUndefined();

		// when: it goes unhealthy and time passes without a successful reconnect
		first.lose();
		const since = link.unhealthySince();
		await clock.advance(100);

		// then: the caller can measure the outage instead of only seeing a boolean
		expect(since).toBe(0);
		expect(clock.now() - (link.unhealthySince() ?? clock.now())).toBe(100);
	});
});
