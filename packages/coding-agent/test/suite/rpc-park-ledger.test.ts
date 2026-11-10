import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostParkLedger } from "../../src/modes/rpc/host-park-ledger.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("reserves a claimed profile's replacement slot before another profile can take the host cap", async () => {
	let builds = 0;
	const build = async () => ({ sessionId: `rpc-${++builds}`, durableSessionId: `durable-${builds}` });
	const ledger = new HostParkLedger(async () => {});
	try {
		for (const key of ["a", "b", "c", "d"]) await ledger.park(key, build);
		expect(ledger.take("a")?.sessionId).toBe("rpc-1");
		ledger.finish("a");
		ledger.replace("a", build);
		expect(await ledger.park("e", build)).toBe("full");
		await vi.advanceTimersByTimeAsync(0);
		expect(await ledger.park("a", build)).toBe("already_parked");
		expect(builds).toBe(5);
	} finally {
		await ledger.stop();
	}
});

it("joins a scheduled replacement without building the same profile twice", async () => {
	let builds = 0;
	const build = async () => ({ sessionId: `rpc-${++builds}`, durableSessionId: `durable-${builds}` });
	const ledger = new HostParkLedger(async () => {});
	try {
		await ledger.park("a", build);
		ledger.take("a");
		ledger.finish("a");
		ledger.replace("a", build);
		await ledger.park("a", build);
		await vi.advanceTimersByTimeAsync(0);
		expect(builds).toBe(2);
		expect(await ledger.park("a", build)).toBe("already_parked");
	} finally {
		await ledger.stop();
	}
});
