import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ADMISSION_LIMITS, CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";

afterEach(() => vi.unstubAllEnvs());

const identity = (admissionId: string, socketEpoch = "epoch-1") => ({
	socketEpoch,
	peer: "peer",
	admissionId,
	fingerprint: "a".repeat(64),
});

it.each([
	{ name: "entries", entries: 2, bytes: ADMISSION_LIMITS.row * 3 },
	{ name: "reserved bytes", entries: 3, bytes: ADMISSION_LIMITS.row * 2 },
])("T2/T5 refuses above the $name bound without forgetting old IDs", async ({ entries, bytes }) => {
	const index = new CompactAdmissions({ entries, bytes });
	const produce = vi.fn(async () => ({ answer: { sessionId: "session-1" }, release: async () => {} }));
	try {
		for (let id = 0; id < 2; id++) await index.run(identity(`id-${id}`), produce);
		await expect(index.run(identity("above-bound"), produce)).rejects.toMatchObject({ reason: "admission_limit" });
		expect(produce).toHaveBeenCalledTimes(2);
		await expect(index.run(identity("id-0"), produce)).resolves.toEqual({ sessionId: "session-1" });
		expect(produce).toHaveBeenCalledTimes(2);
		await expect(index.cancel("epoch-1", "id-0")).resolves.toBe("already_complete");
	} finally {
		await index.dispose();
	}
});

it("T2/T5 retired IDs keep their reservation and cannot allocate a fresh producer", async () => {
	const index = new CompactAdmissions({ entries: 1, bytes: ADMISSION_LIMITS.row });
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const release = vi.fn(async () => {});
	const pending = index.run(identity("retired"), async () => {
		entered.resolve();
		await finish.promise;
		return { answer: { sessionId: "session-1" }, release };
	});
	try {
		await entered.promise;
		expect(await index.cancel("epoch-1", "retired")).toBe("cancelled");
		expect(await index.cancel("epoch-1", "retired")).toBe("cancelled");
		finish.resolve();
		await pending;
		const produce = vi.fn(async () => ({ answer: {}, release }));
		await expect(index.run(identity("retired"), produce)).rejects.toMatchObject({ reason: "admission_retired" });
		await expect(index.run(identity("fresh"), produce)).rejects.toMatchObject({ reason: "admission_limit" });
		expect(produce).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	} finally {
		finish.resolve();
		await pending;
		await index.dispose();
	}
});

it("T2/T5 deletes only the ended epoch's on-disk index and allows reuse in a new epoch", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-admission-index-test-"));
	vi.stubEnv("TMPDIR", root);
	const index = new CompactAdmissions();
	const produce = vi.fn(async () => ({ answer: { sessionId: "session-1" }, release: async () => {} }));
	try {
		await index.run(identity("same-id"), produce);
		const [first] = await readdir(root);
		if (!first) throw new Error("missing epoch index");
		const directory = join(root, first);
		expect(await readdir(directory)).toHaveLength(1);
		await index.run(identity("same-id", "epoch-2"), produce);
		await index.forgetPeer("epoch-1");
		await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(root)).toHaveLength(1);
		await expect(index.run(identity("same-id", "epoch-2"), produce)).resolves.toEqual({ sessionId: "session-1" });
		expect(produce).toHaveBeenCalledTimes(2);
		await index.forgetPeer("epoch-2");
		expect(await readdir(root)).toEqual([]);
	} finally {
		await index.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

it("T2/T5 the default reservation never exceeds either epoch bound", async () => {
	const index = new CompactAdmissions();
	const capacity = Math.min(ADMISSION_LIMITS.entries, Math.floor(ADMISSION_LIMITS.bytes / ADMISSION_LIMITS.row));
	const produce = vi.fn(async () => ({ answer: {}, release: async () => {} }));
	try {
		for (let id = 0; id < capacity; id++) await index.run(identity(`id-${id}`), produce);
		await expect(index.run(identity("full"), produce)).rejects.toMatchObject({ reason: "admission_limit" });
		expect(produce).toHaveBeenCalledTimes(capacity);
		await index.run(identity("id-0"), produce);
		expect(produce).toHaveBeenCalledTimes(capacity);
	} finally {
		await index.dispose();
	}
});

it("T2/T5 pending retries join one producer and remain bounded by the live-producer limit", async () => {
	const index = new CompactAdmissions();
	const finish = Promise.withResolvers<void>();
	const produce = vi.fn(async () => {
		await finish.promise;
		return { answer: { sessionId: "session-1" }, release: async () => {} };
	});
	const pending: Promise<Readonly<Record<string, unknown>>>[] = [];
	try {
		for (let id = 0; id < ADMISSION_LIMITS.hot; id++) {
			pending.push(index.run(identity(`id-${id}`), produce));
			await index.cancel("epoch-1", "unknown");
		}
		pending.push(index.run(identity("id-0"), produce));
		await expect(index.run(identity("above-hot"), produce)).rejects.toMatchObject({ reason: "admission_busy" });
		finish.resolve();
		await expect(Promise.all(pending)).resolves.toEqual(
			Array.from({ length: ADMISSION_LIMITS.hot + 1 }, () => ({ sessionId: "session-1" })),
		);
		expect(produce).toHaveBeenCalledTimes(ADMISSION_LIMITS.hot);
	} finally {
		finish.resolve();
		await Promise.all(pending);
		await index.dispose();
	}
});
