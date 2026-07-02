import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ThreadEntry, ThreadNotFoundError, ThreadRegistry } from "../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../src/modes/app-server/threads/turn-log.ts";

const roots: string[] = [];

async function scratchRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "senpi-app-server-threads-"));
	roots.push(root);
	return root;
}

async function createRegistry(): Promise<{ registry: ThreadRegistry; root: string }> {
	const root = await scratchRoot();
	return {
		root,
		registry: new ThreadRegistry({
			agentDir: join(root, "agent"),
			sessionDir: join(root, "sessions"),
		}),
	};
}

describe("app-server thread registry", () => {
	afterEach(async () => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	it("creates, lists, resumes a warm thread, forks, and deletes", async () => {
		const { registry, root } = await createRegistry();

		const created = await registry.createThread({ cwd: root });
		expect(created.id).toBe(created.session.sessionId);
		expect(created.status).toBe("idle");

		expect(registry.listLoaded().map((thread) => thread.id)).toEqual([created.id]);

		const resumed = await registry.resumeThread(created.id);
		expect(resumed).toBe(created);

		const fork = await registry.forkThread(created.id);
		expect(fork.id).not.toBe(created.id);
		expect(new Set(registry.listLoaded().map((thread) => thread.id))).toEqual(new Set([created.id, fork.id]));

		const listed = await registry.listThreads({ limit: 10 });
		expect(listed.threads.map((thread) => thread.id).sort()).toEqual([created.id, fork.id].sort());
		expect(listed.threads.every((thread) => thread.id === thread.sessionId)).toBe(true);
		expect(listed.threads.every((thread) => "createdAt" in thread && "updatedAt" in thread)).toBe(true);
		expect(listed.threads.every((thread) => typeof thread.status.type === "string")).toBe(true);

		expect(await registry.deleteThread(created.id)).toBe(true);
		expect(registry.listLoaded().map((thread) => thread.id)).toEqual([fork.id]);
		await expect(registry.resumeThread(created.id)).rejects.toBeInstanceOf(ThreadNotFoundError);
	});

	it("paginates listThreads with a deterministic cursor", async () => {
		const { registry, root } = await createRegistry();
		const entries: ThreadEntry[] = [];
		for (let index = 0; index < 3; index++) {
			entries.push(await registry.createThread({ cwd: join(root, `cwd-${index}`) }));
		}

		const firstPage = await registry.listThreads({ limit: 2 });
		expect(firstPage.threads).toHaveLength(2);
		expect(firstPage.nextCursor).toBeTruthy();

		const secondPage = await registry.listThreads({ cursor: firstPage.nextCursor, limit: 2 });
		expect(secondPage.threads).toHaveLength(1);
		expect(secondPage.nextCursor).toBeNull();

		const pagedIds = [...firstPage.threads, ...secondPage.threads].map((thread) => thread.id).sort();
		expect(pagedIds).toEqual(entries.map((entry) => entry.id).sort());
	});

	it("serializes same-thread tasks while other threads can interleave", async () => {
		const { registry, root } = await createRegistry();
		const first = await registry.createThread({ cwd: join(root, "first") });
		const second = await registry.createThread({ cwd: join(root, "second") });
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const firstTask = registry.runThreadTask(first.id, async () => {
			order.push("first:start");
			await firstGate;
			order.push("first:end");
		});
		const queuedBehindFirst = registry.runThreadTask(first.id, async () => {
			order.push("first:queued");
		});

		await until(() => order.includes("first:start"));
		await registry.runThreadTask(second.id, async () => {
			order.push("second");
		});

		expect(order).toEqual(["first:start", "second"]);
		releaseFirst();
		await Promise.all([firstTask, queuedBehindFirst]);
		expect(order).toEqual(["first:start", "second", "first:end", "first:queued"]);
	});

	it("throws a typed error when resuming an unknown thread", async () => {
		const { registry } = await createRegistry();
		await expect(registry.resumeThread("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
			name: "ThreadNotFoundError",
		});
	});

	it("unloads a loaded thread without deleting its durable session", async () => {
		const { registry, root } = await createRegistry();
		const sessionDir = join(root, "sessions");
		const threadId = "44444444-4444-4444-8444-444444444444";
		await mkdir(sessionDir, { recursive: true });
		await writeFile(
			join(sessionDir, `2026-07-02T00-00-00-000Z_${threadId}.jsonl`),
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: threadId,
					timestamp: "2026-07-02T00:00:00.000Z",
					cwd: root,
				}),
				"",
			].join("\n"),
		);
		const entry = await registry.resumeThread(threadId);

		expect(registry.unloadThread(entry.id)).toBe(true);
		expect(registry.listLoaded()).toEqual([]);
		await expect(registry.resumeThread(entry.id)).resolves.toMatchObject({ id: entry.id });
	});
});

describe("app-server turn log", () => {
	it("records turns, appends items, and returns defensive copies", () => {
		const log = new TurnLog();
		log.recordTurn("thread-a", {
			turnId: "turn-1",
			startedAt: "2026-07-02T00:00:00.000Z",
			status: "running",
		});
		log.appendItem("thread-a", "turn-1", { id: "item-1", type: "text", text: "hello" });
		log.recordTurn("thread-a", {
			turnId: "turn-2",
			startedAt: "2026-07-02T00:00:01.000Z",
			status: "completed",
		});

		const turns = log.readTurns("thread-a");
		expect(turns).toEqual([
			{
				turnId: "turn-1",
				startedAt: "2026-07-02T00:00:00.000Z",
				status: "running",
				items: [{ id: "item-1", type: "text", text: "hello" }],
			},
			{
				turnId: "turn-2",
				startedAt: "2026-07-02T00:00:01.000Z",
				status: "completed",
				items: [],
			},
		]);

		turns[0]?.items.push({ id: "mutated" });
		expect(log.readTurns("thread-a")[0]?.items).toEqual([{ id: "item-1", type: "text", text: "hello" }]);
	});
});

async function until(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("condition was not met");
}
