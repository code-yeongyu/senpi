import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { JsonlPeer, type RecordValue } from "../helpers/rpc-jsonl-peer.ts";

/**
 * Observe whether Node reports an unhandled rejection while `body` runs.
 *
 * Node reports an unhandled rejection after the microtask queue drains and before the
 * next macrotask phase. A rejection sentinel created after `body` and left unhandled is
 * reported in that same pass, after any rejection `body` caused, so the check ends on an
 * event rather than on elapsed time.
 */
async function unhandledRejectionDuring(body: () => void): Promise<unknown> {
	const sentinel = new Error("unhandled-rejection sentinel");
	const seen: unknown[] = [];
	let onUnhandled!: (reason: unknown) => void;
	const settled = new Promise<void>((resolve) => {
		onUnhandled = (reason: unknown) => {
			if (reason === sentinel) resolve();
			else seen.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
	});
	try {
		body();
		await new Promise((resolve) => setImmediate(resolve));
		void Promise.reject(sentinel);
		await settled;
		return seen[0];
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("JSONL peer waiter lifecycle", () => {
	// Every waiter in this suite is armed BEFORE the command that triggers it and
	// awaited only after that command returns. Whatever rejects in that window -
	// the timeout, or close() during teardown - rejects a promise nobody is
	// holding yet. A longer timeout only narrows the window; the rejection must be
	// handled from the moment the waiter exists.
	it("does not surface an unhandled rejection when an armed waiter times out before it is awaited", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const peer = new JsonlPeer(new PassThrough(), () => {});
		let pending!: Promise<RecordValue>;

		const reason = await unhandledRejectionDuring(() => {
			pending = peer.waitFor(() => false, 1);
			vi.advanceTimersByTime(1);
		}).finally(() => vi.useRealTimers());

		expect(reason).toBeUndefined();
		// The rejection still reaches the eventual awaiter; it is handled, not swallowed.
		await expect(pending).rejects.toThrow(/Timed out waiting for RPC record/);
	});

	it("does not surface an unhandled rejection when close() settles an armed waiter", async () => {
		const peer = new JsonlPeer(new PassThrough(), () => {});
		let pending!: Promise<RecordValue>;

		const reason = await unhandledRejectionDuring(() => {
			pending = peer.waitFor(() => false, 60_000);
			peer.close();
		});

		expect(reason).toBeUndefined();
		await expect(pending).rejects.toThrow(/RPC peer closed/);
	});

	it("still resolves a waiter armed before the matching record arrives", async () => {
		const stream = new PassThrough();
		const peer = new JsonlPeer(stream, () => {});

		const pending = peer.waitFor((value) => value.type === "late", 15_000);
		stream.write(`${JSON.stringify({ type: "late", ok: true })}\n`);

		expect(await pending).toMatchObject({ type: "late", ok: true });
	});
});
