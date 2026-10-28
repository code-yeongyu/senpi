import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { FRAGMENT_ENVELOPE_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { TRANSFER_STAGING_MAX_BYTES } from "../../../src/modes/rpc/compact-transfer-staging.ts";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";
import {
	HostPermits,
	hostWorkerPermits,
	PERMIT_TAG,
	WORKER_CONTROL_SLOTS,
	PERMIT_WORD,
	WORKER_PERMIT_BYTES,
	WorkerPermitLedger,
} from "../../../src/modes/rpc/session-worker-permits.ts";
import { within, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const noop = () => {};

/** Resolves once the isolate's own word says it is blocked waiting on a permit (it notifies when it starts). */
async function workerWaiting(block: SharedArrayBuffer, ms = 20_000): Promise<void> {
	const state = new Int32Array(block);
	const waited = Atomics.waitAsync(state, PERMIT_WORD.worker, PERMIT_TAG.idle, ms);
	if (waited.async) await waited.value;
	expect(Atomics.load(state, PERMIT_WORD.worker), "the isolate is blocked on its permit").toBe(PERMIT_TAG.waiting);
}

/** A real isolate asking one permit block; its typed outcome and its exit code, each awaited under a deadline. */
function gateIsolate(block: SharedArrayBuffer, timeoutMs: number) {
	const isolate = new Worker(new URL("./4272-worker-permit-gate-support.ts", import.meta.url), {
		workerData: { block, timeoutMs },
	});
	const answer = new Promise<{ outcome: string; built: number }>((resolve) => isolate.once("message", resolve));
	const exit = new Promise<number>((resolve) => isolate.once("exit", resolve));
	return {
		isolate,
		answer: () => within("permit answer", answer),
		exit: () => within("isolate exit", exit),
	};
}

/** A ledger whose only data permit is already taken, and a worker's host half that therefore holds no permit. */
function exhausted() {
	const ledger = new WorkerPermitLedger(2 * WORKER_PERMIT_BYTES);
	expect(ledger.request(noop)).toBe(true);
	const permits = new HostPermits(ledger);
	return { ledger, permits, state: new Int32Array(permits.block) };
}

// Part of #4272, RULING-63 Q3 + RULING-69 (1): the initial credit is ONE S11 page in bytes, derived from the envelope.
it("S12b RULING-63 initial credit: a fresh block holds exactly one S11 page envelope of credit, granted by the host", () => {
	expect(WORKER_PERMIT_BYTES).toBe(FRAGMENT_ENVELOPE_MAX_BYTES);
	const ledger = new WorkerPermitLedger();
	const permits = new HostPermits(ledger);
	const state = new Int32Array(permits.block);
	expect(Atomics.load(state, PERMIT_WORD.credit)).toBe(FRAGMENT_ENVELOPE_MAX_BYTES);
	expect(Atomics.load(state, PERMIT_WORD.host)).toBe(PERMIT_TAG.granted);
	expect(ledger.status()).toEqual({ granted: 1, waiting: 0, ceiling: ledger.ceiling });
	permits.close();
	expect(ledger.status().granted, "closing returns the held permit").toBe(0);
});

// S12 design section 3 / X04: B_worker bounds the ledger; one slot stays protected for control progress.
it("S12b X04: the ledger grants at most its data ceiling, refuses the next request before allocation and hands a release to it", () => {
	const ledger = new WorkerPermitLedger();
	// RULING-80 (1): the data ceiling is B_worker in whole S11 pages, less the protected control slot, from the constants.
	expect(WORKER_CONTROL_SLOTS).toBe(1);
	expect(ledger.ceiling).toBe(
		Math.floor(TRANSFER_STAGING_MAX_BYTES / FRAGMENT_ENVELOPE_MAX_BYTES) - WORKER_CONTROL_SLOTS,
	);
	for (let index = 0; index < ledger.ceiling; index += 1) expect(ledger.request(noop)).toBe(true);
	const allocate = vi.fn();
	expect(ledger.request(allocate), "past the ceiling the request is refused").toBe(false);
	expect(allocate, "nothing is allocated for a refused request").not.toHaveBeenCalled();
	expect(ledger.status()).toEqual({ granted: ledger.ceiling, waiting: 1, ceiling: ledger.ceiling });
	ledger.release();
	expect(allocate).toHaveBeenCalledTimes(1);
	expect(ledger.status()).toEqual({ granted: ledger.ceiling, waiting: 0, ceiling: ledger.ceiling });
});

it("S12b X04: one worker never holds two frames: a permit is granted again only after the worker consumed it", () => {
	const ledger = new WorkerPermitLedger();
	const permits = new HostPermits(ledger);
	const state = new Int32Array(permits.block);
	permits.returned();
	expect(Atomics.load(state, PERMIT_WORD.credit), "an unconsumed permit is not granted twice").toBe(
		WORKER_PERMIT_BYTES,
	);
	expect(ledger.status().granted).toBe(1);
	Atomics.sub(state, PERMIT_WORD.credit, WORKER_PERMIT_BYTES);
	permits.returned();
	expect(Atomics.load(state, PERMIT_WORD.credit)).toBe(WORKER_PERMIT_BYTES);
	expect(ledger.status().granted).toBe(1);
	permits.close();
});

// RULING-63 Q3 conditions (2) + (4): a looped, bounded wait ends typed and the isolate never built its payload.
it("S12b RULING-63 Q3 (4): a host that never grants leaves the worker with a typed timeout and no payload built", async () => {
	const { answer, exit } = gateIsolate(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT), 200);
	expect(await answer()).toEqual({ outcome: "timeout", built: 0 });
	expect(await exit()).toBe(0);
});

it("S12b RULING-63 Q3: a deny is typed and recoverable: the waiting worker takes the permit a later release grants", async () => {
	const { ledger, permits, state } = exhausted();
	expect(Atomics.load(state, PERMIT_WORD.host), "the host denied before any payload exists").toBe(PERMIT_TAG.denied);
	const { answer, exit } = gateIsolate(permits.block, 20_000);
	await workerWaiting(permits.block);
	ledger.release();
	expect(await answer()).toEqual({ outcome: "granted", built: 1 });
	expect(await exit()).toBe(0);
	expect(Atomics.load(state, PERMIT_WORD.credit), "the isolate consumed exactly the one permit").toBe(0);
	permits.close();
});

it("S12b RULING-63 Q3: a deny that never clears ends the wait typed as denied, with no payload built", async () => {
	const { permits } = exhausted();
	const { answer } = gateIsolate(permits.block, 200);
	expect(await answer()).toEqual({ outcome: "denied", built: 0 });
	permits.close();
});

// RULING-63 Q3 condition (3): close and termination notify every waiter; the blocked worker never hangs.
it("S12b RULING-63 Q3 (3): a worker blocked on a permit wakes and exits cleanly when the host closes", async () => {
	const { permits } = exhausted();
	const { answer, exit } = gateIsolate(permits.block, 20_000);
	await workerWaiting(permits.block);
	permits.close();
	expect(await answer()).toEqual({ outcome: "closed", built: 0 });
	expect(await exit()).toBe(0);
});

it("S12b RULING-63 Q3 (3): a worker blocked on a permit ends when it is terminated (the host dying)", async () => {
	const { permits } = exhausted();
	const { isolate, exit } = gateIsolate(permits.block, 20_000);
	await workerWaiting(permits.block);
	await isolate.terminate();
	expect(await exit()).toBe(1);
	permits.close();
});

// X03 X04 through the real worker: the host holds the initial permit, and the isolate posts no payload before it.
it("S12b X03 X04: with the initial permit held, the real worker posts no ready payload until the host grants, then one bounded frame", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	let held = 0;
	while (hostWorkerPermits.status().granted < hostWorkerPermits.ceiling) {
		hostWorkerPermits.request(noop);
		held += 1;
	}
	const asked = Promise.withResolvers<void>();
	const request = hostWorkerPermits.request.bind(hostWorkerPermits);
	vi.spyOn(hostWorkerPermits, "request").mockImplementation((grant) => {
		const granted = request(grant);
		asked.resolve();
		return granted;
	});
	const host = await workerAcceptanceHost();
	try {
		const opened = host.open();
		await within("the worker host asked for its initial permit", asked.promise);
		const worker = host.workers.at(-1);
		const block = worker?.intake?.permits.block;
		if (!worker || !block) throw new Error("flag on: the worker client owns a permit block");
		const posted: string[] = [];
		worker.worker.on("message", (message: SessionWorkerToHost) => posted.push(message.type));
		// A real isolate first loads its module graph and opens its session (carry 13), well inside the test budget.
		await workerWaiting(block, 60_000);
		expect(Atomics.load(new Int32Array(block), PERMIT_WORD.host)).toBe(PERMIT_TAG.denied);
		expect(posted, "no payload frame before the permit").not.toContainEqual(
			expect.stringMatching(/^(ready|snapshot|output|canonical|fragment)$/),
		);
		hostWorkerPermits.release();
		held -= 1;
		await opened;
		expect(
			posted.filter((type) => type === "ready"),
			"the bootstrap travelled as one frame",
		).toEqual(["ready"]);
		expect(posted).not.toContain("fragment");
		expect(host.failures).toEqual([]);
	} finally {
		for (; held > 0; held -= 1) hostWorkerPermits.release();
		await host.dispose();
	}
}, 90_000);
