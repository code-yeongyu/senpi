import { afterEach, expect, it, vi } from "vitest";
import { FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import { TransferStaging } from "../../../src/modes/rpc/compact-transfer-staging.ts";
import { PERMIT_WORD, WORKER_PERMIT_BYTES } from "../../../src/modes/rpc/session-worker-permits.ts";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { within, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

/** Code units one fragment carries: D stored bytes, two per UTF-16 code unit. */
const UNITS = FRAGMENT_MAX_BYTES / 2;

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

/** An unordered payload message as the worker transport fragments it: its JSON in pieces of at most D stored bytes. */
function fragmentsOf(message: Record<string, unknown> & { readonly type: string }) {
	const text = JSON.stringify(message);
	return Array.from({ length: Math.ceil(text.length / UNITS) }, (_unused, index) => ({
		type: "fragment" as const,
		of: message.type,
		length: text.length * 2,
		offset: index * UNITS * 2,
		text: text.slice(index * UNITS, (index + 1) * UNITS),
	}));
}

/** A real worker session whose isolate holds its granted, unspent permit, with the host's view of that permit. */
async function idleWorker() {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const host = await workerAcceptanceHost();
	const { worker } = await host.open();
	const intake = worker.intake;
	const snapshot = worker.snapshot;
	if (!intake || !snapshot) throw new Error("flag on: the opened worker client owns an intake and a snapshot");
	const credit = new Int32Array(intake.permits.block);
	expect(Atomics.load(credit, PERMIT_WORD.credit), "the idle isolate holds one unspent permit").toBe(
		WORKER_PERMIT_BYTES,
	);
	/** The isolate taking its permit for its next frame, as `WorkerPermitGate.acquire` does. */
	const spend = () => Atomics.sub(credit, PERMIT_WORD.credit, WORKER_PERMIT_BYTES);
	const big = { ...snapshot, state: { ...snapshot.state, padding: "x".repeat(3 * UNITS) } };
	return { host, worker, intake, credit, spend, big };
}

// Part of #4272, S12b review of #4668: a `ready` is posted without a credit wait, so the isolate may spend the permit the
// final fragment returned before the host has reassembled the message. The reassembled message is not a frame of its own
// and must not return a second permit: one worker never holds two frames.
it("S12b review: a fragmented ready returns its permits once per fragment, never again when reassembled", async () => {
	const { host, worker, intake, credit, spend, big } = await idleWorker();
	try {
		const reassembled = Promise.withResolvers<void>();
		const received = intake.received.bind(intake);
		vi.spyOn(intake, "received").mockImplementation((message: SessionWorkerToHost) => {
			received(message);
			if (message.type === "ready") reassembled.resolve();
		});
		const fragments = fragmentsOf({ type: "ready", request: -1, snapshot: big });
		expect(fragments.length).toBeGreaterThan(1);
		for (const fragment of fragments) {
			spend();
			worker.worker.emit("message", fragment);
			expect(Atomics.load(credit, PERMIT_WORD.credit), "each fragment's permit returns once").toBe(
				WORKER_PERMIT_BYTES,
			);
		}
		spend();
		await within("the reassembled ready reaches the host", reassembled.promise);
		expect(
			Atomics.load(credit, PERMIT_WORD.credit),
			"the isolate's next frame is in flight: no second permit beside it",
		).toBe(0);
		expect(host.failures).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 120_000);

// S12b review of #4668: retiring the lane closes its staging store while a reassembled message is still being read; the
// store's close already releases that content, so the read's own cleanup must not release it again.
it("S12b review: closing the staging store while a fragmented message is reassembling releases its content exactly once", async () => {
	const { host, worker, spend, big } = await idleWorker();
	try {
		const releases: unknown[] = [];
		const release = TransferStaging.prototype.release;
		vi.spyOn(TransferStaging.prototype, "release").mockImplementation(function (
			this: TransferStaging,
			...args: Parameters<TransferStaging["release"]>
		) {
			if (args[0].ref.entry.kind === "worker_frame") releases.push(args[0]);
			return release.apply(this, args);
		});
		const signal = new SharedArrayBuffer(4);
		const fragments = fragmentsOf({ type: "snapshot", snapshot: big, settled: false });
		for (const [index, fragment] of fragments.entries()) {
			spend();
			worker.worker.emit("message", index === fragments.length - 1 ? { ...fragment, signal } : fragment);
		}
		// The final fragment started the read; the isolate reports a failure before the read resumes, which retires the lane
		// and closes its staging store under the read.
		worker.worker.emit("message", { type: "failure", error: "session_worker_isolate_failed" });
		await within("worker incarnation exits", worker.exited);
		await worker.acceptance?.idle();
		expect(host.failures).toEqual(["session_worker_isolate_failed"]);
		expect(releases, "the reassembling content was released exactly once").toHaveLength(1);
	} finally {
		await host.dispose();
	}
}, 120_000);
