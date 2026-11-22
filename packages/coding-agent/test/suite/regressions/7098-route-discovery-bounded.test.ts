// senpi#7098 follow-up (review of #7105, HIGH-1). On a successor, every `list_sessions` first asks the draining
// predecessor which sessions it still holds. The predecessor exiting in the middle of that question is the normal
// end of a drain, and a stalled predecessor never answers it. Neither may turn the successor's own roster read into
// a failure or a hang: the predecessor's sessions are simply not listed through a route that answer would have made.
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PREDECESSOR_DISCOVERY_TIMEOUT_MS } from "../../../src/modes/rpc/predecessor-discovery.ts";
import {
	advanceUntil,
	type Cleanups,
	fakePredecessor,
	successorWithPredecessorClaim,
} from "../rpc-predecessor-route-support.ts";

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

it.skipIf(process.platform === "win32")(
	"a predecessor that never answers bounds list_sessions by the discovery deadline",
	async () => {
		const host = await successorListingOwnSession();
		const asked = Promise.withResolvers<void>();
		await fakePredecessor(cleanups, host, { list_sessions: () => asked.resolve() });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const listing = host.list();
		await asked.promise;

		expect(
			await advanceUntil(listing, PREDECESSOR_DISCOVERY_TIMEOUT_MS, 100),
			"list_sessions did not answer once the discovery deadline passed",
		).toBe(true);
		expect(await listing).toMatchObject({
			success: true,
			data: { sessions: [{ sessionPath: join(host.root, "own.jsonl") }] },
		});
	},
);
