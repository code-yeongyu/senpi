import { afterEach, describe, expect, it, vi } from "vitest";
import {
	REPLACED_CONFIRMATIONS,
	SUPERSESSION_POLL_MS,
	watchForSupersession,
} from "../../../src/modes/rpc/host-supersession.ts";

/**
 * senpi#3653: a generation whose endpoint has no file identity (a win32 named pipe) cannot compare
 * inodes, so supersession is proven by two positive observations instead: the pointer names another
 * instance AND the public endpoint answers with that same instance id. Anything less - an unanswered
 * probe, a missing pointer, an answer from itself or from a third instance - is no evidence, and the
 * watch must fail closed rather than drain a generation that may still be the one serving.
 */
const SELF = "self-instance";
const NEXT = "next-instance";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.useRealTimers();
});

function watchWith(
	pointer: () => string | undefined,
	answer: () => string | undefined,
): { losses: string[]; probes: () => number } {
	const losses: string[] = [];
	let probes = 0;
	vi.useFakeTimers();
	const stop = watchForSupersession(
		{
			path: "named-pipe",
			identity: undefined,
			pointer: { file: "host.pid", instanceId: SELF },
			readPointerInstanceId: async () => pointer(),
			probeInstanceId: async () => {
				probes += 1;
				return answer();
			},
		},
		(loss) => losses.push(loss),
	);
	cleanups.push(stop);
	return { losses, probes: () => probes };
}

async function polls(count: number): Promise<void> {
	for (let poll = 0; poll < count; poll++) await vi.advanceTimersByTimeAsync(SUPERSESSION_POLL_MS);
}

describe("issue 3653: supersession without a socket identity", () => {
	it("drains once the pointer and the endpoint both name the same other instance", async () => {
		// given: the pointer names a successor and the endpoint answers as that successor
		const watch = watchWith(
			() => NEXT,
			() => NEXT,
		);
		// when: more agreeing polls pass than the confirmation count
		await polls(REPLACED_CONFIRMATIONS + 3);
		// then: the loss is reported exactly once
		expect(watch.losses).toEqual(["replaced"]);
	});

	it("needs consecutive confirmations, so one short streak never drains", async () => {
		const watch = watchWith(
			() => NEXT,
			() => NEXT,
		);
		await polls(REPLACED_CONFIRMATIONS - 1);
		expect(watch.losses).toEqual([]);
	});

	it("never drains on an unanswered probe", async () => {
		const watch = watchWith(
			() => NEXT,
			() => undefined,
		);
		await polls(REPLACED_CONFIRMATIONS + 3);
		expect(watch.losses).toEqual([]);
	});

	it("never drains while the endpoint still answers as this generation", async () => {
		const watch = watchWith(
			() => NEXT,
			() => SELF,
		);
		await polls(REPLACED_CONFIRMATIONS + 3);
		expect(watch.losses).toEqual([]);
	});

	it("never drains when the endpoint answers as an instance the pointer does not name", async () => {
		const watch = watchWith(
			() => NEXT,
			() => "third-instance",
		);
		await polls(REPLACED_CONFIRMATIONS + 3);
		expect(watch.losses).toEqual([]);
	});

	it("never treats a missing pointer as a loss, and does not even probe", async () => {
		const watch = watchWith(
			() => undefined,
			() => NEXT,
		);
		await polls(REPLACED_CONFIRMATIONS + 3);
		expect(watch.losses).toEqual([]);
		expect(watch.probes()).toBe(0);
	});

	it("does not probe while the pointer still names this generation", async () => {
		const watch = watchWith(
			() => SELF,
			() => NEXT,
		);
		await polls(REPLACED_CONFIRMATIONS + 3);
		expect(watch.losses).toEqual([]);
		expect(watch.probes()).toBe(0);
	});

	it("resets the count when an observation in between fails", async () => {
		const answers: Array<string | undefined> = [NEXT, NEXT, undefined, NEXT, NEXT];
		const watch = watchWith(
			() => NEXT,
			() => answers.shift(),
		);
		await polls(5);
		expect(watch.losses).toEqual([]);
	});

	it("does nothing at all without a pointer to compare", async () => {
		vi.useFakeTimers();
		const losses: string[] = [];
		const stop = watchForSupersession({ path: "named-pipe", identity: undefined }, (loss) => losses.push(loss));
		cleanups.push(stop);
		await polls(REPLACED_CONFIRMATIONS + 3);
		expect(losses).toEqual([]);
	});
});
