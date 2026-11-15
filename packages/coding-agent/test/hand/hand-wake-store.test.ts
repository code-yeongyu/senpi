// senpi#6767 review: the hand's wake outbox file stays bounded by what is pending (H1), an older process can no longer
// write it once a newer one opened it (L1), un-acked wakes are capped with reported drops (M1), and a malformed entry
// is dropped and reported instead of being re-offered forever (L2).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHandWakeOutbox } from "../../src/modes/hand/hand-wakes.ts";
import { brainInbox, connect } from "./hand-wake-fixture.ts";
import { cleanupHands, handDirs } from "./remote-hand-fixture.ts";

const closers: Array<() => void> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) close();
	await cleanupHands();
});

const wakeOf = (scope: string, index: number) => ({
	scope,
	source: "message",
	payload: { message: { customType: "late", content: `m${index}`, display: false } },
});

async function storePath(prefix: string): Promise<string> {
	return join((await handDirs(prefix)).agentDir, "rpc", "hand-wakes.json");
}

describe("the hand's wake outbox file", () => {
	it("stays the same size over any number of offer+ack cycles: it keeps what is pending, never a log", async () => {
		const path = await storePath("h3-flat");
		const outbox = await openHandWakeOutbox(path);
		const cycles = async (count: number) => {
			for (let index = 0; index < count; index++) {
				const wake = await outbox.offer(wakeOf("s", index));
				await outbox.receipt({ kind: "ack", eventId: wake.eventId, duplicate: false });
			}
			return statSync(path).size;
		};

		const after20 = await cycles(20);
		const after120 = await cycles(100);

		expect(await outbox.pending()).toEqual([]);
		expect(after120).toBe(after20);
	});

	it("refuses a commit from a process that opened it before a newer one did, and keeps the newer one's state", async () => {
		const path = await storePath("h3-fence");
		const older = await openHandWakeOutbox(path);
		const newer = await openHandWakeOutbox(path);
		const kept = await newer.offer(wakeOf("s", 1));

		await expect(older.offer(wakeOf("s", 2))).rejects.toThrow(/epoch/);

		expect((await (await openHandWakeOutbox(path)).pending()).map((wake) => wake.eventId)).toEqual([kept.eventId]);
	});

	it("keeps at most a scope's bound un-acked, dropping the oldest, and reports the drop to the brain as overflow", async () => {
		const path = await storePath("h3-overflow");
		const outbox = await openHandWakeOutbox(path);
		for (let index = 0; index < 300; index++) await outbox.offer(wakeOf("s", index));
		const kept = await outbox.pending();

		expect(kept).toHaveLength(256);
		expect(kept[0]?.payload).toMatchObject({ message: { content: "m44" } });
		const brain = await brainInbox();
		const link = connect(brain, outbox);
		closers.push(() => link.close());
		await link.hand.ready;
		const drop = await brain.committed.next("the overflow report");
		expect(drop).toMatchObject({ scope: "s", source: "wake.dropped", payload: { reason: "overflow", count: 44 } });
	});

	it("drops a malformed pending entry with a fault and a drop report, and never offers it", async () => {
		const path = await storePath("h3-malformed");
		const seed = await openHandWakeOutbox(path);
		await seed.offer(wakeOf("s", 1));
		const file = JSON.parse(readFileSync(path, "utf8")) as { documents: [string, { pending: unknown[] }][] };
		const [, record] = file.documents.find(([key]) => key.startsWith("execution.wake-outbox:")) ?? [];
		record?.pending.push({ scope: "s", source: 7 });
		writeFileSync(path, JSON.stringify(file));

		const faults: Error[] = [];
		const brain = await brainInbox();
		const link = connect(brain, await openHandWakeOutbox(path, { onFault: (error) => faults.push(error) }));
		closers.push(() => link.close());
		await link.hand.ready;
		const offered = [await brain.committed.next("the malformed report"), await brain.committed.next("the good wake")];

		expect(offered.map((wake) => [wake.source, wake.payload])).toEqual([
			["wake.dropped", { reason: "malformed", count: 1 }],
			["message", wakeOf("s", 1).payload],
		]);
		expect(faults.map((error) => error.name)).toEqual(["MalformedWakeError"]);
	});
});
