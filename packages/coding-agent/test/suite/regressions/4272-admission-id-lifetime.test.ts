import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ADMISSION_LIMITS, CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";

afterEach(() => vi.unstubAllEnvs());

// #5274 / RULING-113: only live attempts are capped; done rows live in a bounded per-epoch LRU, evicted IDs
// leave a digest in a bounded ring, and retries are not distinguishable on the wire (R3 C4.4 resends the same
// admissionId), so a retry older than the ring is the documented, counted residual.
const identity = (admissionId: string) => ({
	socketEpoch: "epoch-1",
	peer: "peer",
	admissionId,
	fingerprint: "a".repeat(64),
});
const capacity = Math.min(ADMISSION_LIMITS.entries, Math.floor(ADMISSION_LIMITS.bytes / ADMISSION_LIMITS.row));
const answering = () => vi.fn(async () => ({ answer: { sessionId: "session-1" }, release: async () => {} }));

async function isolatedRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-admission-lifetime-test-"));
	vi.stubEnv("TMPDIR", root);
	return root;
}

async function rowFiles(root: string): Promise<number> {
	const [epoch] = await readdir(root);
	return epoch ? (await readdir(join(root, epoch))).length : 0;
}

it("#5274 a long-lived socket admits its 10,000th open with bounded rows and a counted ring overflow", async () => {
	const root = await isolatedRoot();
	const index = new CompactAdmissions();
	const produce = answering();
	try {
		for (let id = 0; id < 10_000; id++) await index.run(identity(`id-${id}`), produce);
		expect(produce).toHaveBeenCalledTimes(10_000);
		expect(await rowFiles(root)).toBe(capacity);
		expect(index.status().retiredOverflow).toBe(10_000 - capacity - ADMISSION_LIMITS.retired);
		// The ring still holds exactly the newest ADMISSION_LIMITS.retired evicted IDs.
		const oldestRetired = 10_000 - capacity - ADMISSION_LIMITS.retired;
		await expect(index.run(identity(`id-${oldestRetired}`), produce)).rejects.toMatchObject({
			reason: "admission_retired",
		});
		expect(produce).toHaveBeenCalledTimes(10_000);
		// Documented fallback: an ID older than the ring is indistinguishable from a fresh open.
		await index.run(identity("id-0"), produce);
		expect(produce).toHaveBeenCalledTimes(10_001);
	} finally {
		await index.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 600_000);

it("#5274 a recent retry gets its stored result without another producer", async () => {
	const index = new CompactAdmissions();
	const produce = vi.fn(async (_signal: AbortSignal) => ({
		answer: { sessionId: `session-${produce.mock.calls.length}` },
		release: async () => {},
	}));
	try {
		for (let id = 0; id <= capacity; id++) await index.run(identity(`id-${id}`), produce);
		await expect(index.run(identity(`id-${capacity}`), produce)).resolves.toEqual({
			sessionId: `session-${capacity + 1}`,
		});
		await expect(index.run(identity("id-1"), produce)).resolves.toEqual({ sessionId: "session-2" });
		expect(produce).toHaveBeenCalledTimes(capacity + 1);
	} finally {
		await index.dispose();
	}
}, 600_000);

it("#5274 an evicted ID frees its row and answers admission_retired", async () => {
	const root = await isolatedRoot();
	const index = new CompactAdmissions();
	const produce = answering();
	try {
		for (let id = 0; id <= capacity; id++) await index.run(identity(`id-${id}`), produce);
		expect(await rowFiles(root)).toBe(capacity);
		await expect(index.run(identity("id-0"), produce)).rejects.toMatchObject({ reason: "admission_retired" });
		await expect(index.cancel("epoch-1", "id-0")).resolves.toBe("already_complete");
		expect(produce).toHaveBeenCalledTimes(capacity + 1);
		expect(index.status().retiredOverflow).toBe(0);
	} finally {
		await index.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 600_000);

it("#5274 live attempts, not lifetime IDs, reach the cap", async () => {
	const small = new CompactAdmissions({ entries: 2, bytes: ADMISSION_LIMITS.row * 2 });
	const index = new CompactAdmissions();
	const finish = Promise.withResolvers<void>();
	const held = vi.fn(async () => {
		await finish.promise;
		return { answer: { sessionId: "session-1" }, release: async () => {} };
	});
	const pending: Promise<unknown>[] = [];
	try {
		for (let id = 0; id < 2; id++) pending.push(small.run(identity(`small-${id}`), held));
		for (let id = 0; id < ADMISSION_LIMITS.hot; id++) {
			pending.push(index.run(identity(`live-${id}`), held));
			await index.cancel("epoch-1", "unknown");
		}
		await small.cancel("epoch-1", "unknown");
		await expect(small.run(identity("small-over"), held)).rejects.toMatchObject({ reason: "admission_limit" });
		await expect(index.run(identity("live-over"), held)).rejects.toMatchObject({ reason: "admission_busy" });
		finish.resolve();
		await Promise.all(pending);
		const produce = answering();
		await small.run(identity("small-after"), produce);
		await index.run(identity("live-after"), produce);
		expect(produce).toHaveBeenCalledTimes(2);
	} finally {
		finish.resolve();
		await Promise.allSettled(pending);
		await small.dispose();
		await index.dispose();
	}
}, 600_000);
