// senpi#7098 follow-up (review of #7105, HIGH-1). On a successor, every `list_sessions` first asks the draining
// predecessor which sessions it still holds. The predecessor exiting in the middle of that question is the normal
// end of a drain, and a stalled predecessor never answers it. Neither may turn the successor's own roster read into
// a failure or a hang: the predecessor's sessions are simply not listed through a route that answer would have made.
import { pbkdf2 } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREDECESSOR_DISCOVERY_TIMEOUT_MS } from "../../../src/modes/rpc/predecessor-discovery.ts";
import { type Cleanups, fakePredecessor, successorWithPredecessorClaim } from "../rpc-predecessor-route-support.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function successorListingOwnSession() {
	const host = await successorWithPredecessorClaim(cleanups);
	expect(
		await host.send({
			type: "open_session",
			id: "own",
			cwd: host.root,
			sessionPath: join(host.root, "own.jsonl"),
			retain_on_disconnect: true,
		}),
	).toMatchObject({ success: true });
	await host.predecessorHolds();
	return host;
}

it.skipIf(process.platform === "win32")(
	"a predecessor that exits mid-answer leaves list_sessions answering with the successor's own rows",
	async () => {
		const host = await successorListingOwnSession();
		await fakePredecessor(cleanups, host, { list_sessions: (stream) => stream.destroy() });

		const listed = await host.list();

		expect(listed).toMatchObject({
			success: true,
			data: { sessions: [{ sessionPath: join(host.root, "own.jsonl") }] },
		});
		expect((listed as { data: { sessions: unknown[] } }).data.sessions).toHaveLength(1);
	},
);

/** Keeps every libuv pool thread busy, as a loaded host does: the listing's file reads after the deadline queue behind it. */
function occupyThreadPool(): Promise<void> {
	const threads = Number(process.env.UV_THREADPOOL_SIZE) || 4;
	const jobs = Array.from(
		{ length: threads * 4 },
		() =>
			new Promise<void>((resolve, reject) =>
				pbkdf2("senpi", "7098", 100_000, 64, "sha512", (error) => (error ? reject(error) : resolve())),
			),
	);
	return Promise.all(jobs).then(() => undefined);
}

describe.skipIf(process.platform === "win32")("a predecessor that never answers", () => {
	it.each([
		["a quick host", false],
		["a host whose file reads are slow", true],
	] as const)("bounds list_sessions by the discovery deadline, on %s", async (_host, slow) => {
		const host = await successorListingOwnSession();
		const asked = Promise.withResolvers<void>();
		const gaveUp = Promise.withResolvers<void>();
		await fakePredecessor(cleanups, host, {
			list_sessions: (stream) => {
				stream.once("close", () => gaveUp.resolve());
				asked.resolve();
			},
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const listing = host.list();
		// The request is written and its deadline armed in the same tick, so the deadline is pending once it arrives.
		await asked.promise;
		const busy = slow ? occupyThreadPool() : Promise.resolve();
		vi.advanceTimersByTime(PREDECESSOR_DISCOVERY_TIMEOUT_MS);

		// At its deadline the successor stops waiting and closes the predecessor's connection. What the listing still reads
		// after that is ordinary file I/O: it is awaited, never raced against a fixed number of event-loop turns.
		await gaveUp.promise;
		expect(await listing).toMatchObject({
			success: true,
			data: { sessions: [{ sessionPath: join(host.root, "own.jsonl") }] },
		});
		await busy;
	});
});
