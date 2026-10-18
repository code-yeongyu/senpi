import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as storedValues from "@earendil-works/pi-agent-core";
import * as sessionWrites from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepo, SqliteStorage, sql } from "../src/index.ts";
import { applyInitialSchema } from "../src/sqlite/migrations.ts";

const SESSION_ID = "session";
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function collectUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
	const unhandled: unknown[] = [];
	const listener = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", listener);
	try {
		await run();
		await new Promise<void>((resolve) => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", listener);
	}
	return unhandled;
}

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-close-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("SQLite close hardening", () => {
	it("settles a commit issued before close and rejects later work with a defined error", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		await applyInitialSchema(db);
		sql`INSERT INTO sessions
			(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
			VALUES (${SESSION_ID}, ${1}, ${null}, ${1}, ${null}, ${0}, ${JSON.stringify(ZERO_USAGE)}, ${1})`.run(db);
		const storage = new SqliteStorage(db, { sessionId: SESSION_ID, now: () => 1_700_000_000_000 });

		const unhandled = await collectUnhandledRejections(async () => {
			const committing = storage.commit(
				[storedValues.setValue(storedValues.sessionName, "before-close")],
				BACKGROUND_CONTEXT,
			);
			const closed = storage.close(BACKGROUND_CONTEXT);
			expect(storage.close(BACKGROUND_CONTEXT)).toBe(closed);
			const lateCommit = storage.commit(
				[storedValues.setValue(storedValues.sessionName, "after-close")],
				BACKGROUND_CONTEXT,
			);
			const lateRead = storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT);

			await expect(lateCommit).rejects.toThrow("SqliteStorage is closed");
			await expect(lateRead).rejects.toThrow("SqliteStorage is closed");
			expect((await committing).seqs).toEqual([1]);
			await closed;

			const reader = new SqliteStorage(db, { sessionId: SESSION_ID });
			expect((await reader.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe("before-close");
			await reader.close(BACKGROUND_CONTEXT);
			db.close();
			await expect(
				storage.commit([storedValues.setValue(storedValues.sessionName, "after-db-close")], BACKGROUND_CONTEXT),
			).rejects.toThrow("SqliteStorage is closed");
		});

		expect(unhandled).toEqual([]);
	});

	it("lets admitted reads and writes finish before the session closes its database", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const session = await repo.create({ id: SESSION_ID }, BACKGROUND_CONTEXT);
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							sessionWrites.insertEntry({ id: "child", parentId: "root", type: "custom", customType: "child" }),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			const unhandled = await collectUnhandledRejections(async () => {
				const scan = session.scanBranch({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT);
				const entries = session.getEntries(["root", "child"], BACKGROUND_CONTEXT);
				const rename = session.setName("renamed-before-close", BACKGROUND_CONTEXT);
				const closed = session.close(BACKGROUND_CONTEXT);
				expect(session.close(BACKGROUND_CONTEXT)).toBe(closed);
				const lateRead = session.getStats(BACKGROUND_CONTEXT);
				const lateWrite = session.setName("renamed-after-close", BACKGROUND_CONTEXT);

				await expect(lateRead).rejects.toThrow("Session is closed");
				await expect(lateWrite).rejects.toThrow("Session is closed");
				expect((await scan).map((entry) => entry.id)).toEqual(["root", "child"]);
				expect([...(await entries).keys()]).toEqual(["root", "child"]);
				await rename;
				await closed;
			});
			expect(unhandled).toEqual([]);

			const [metadata] = await repo.list(undefined, BACKGROUND_CONTEXT);
			const reopened = await repo.open(metadata!, BACKGROUND_CONTEXT);
			expect(await reopened.getName(BACKGROUND_CONTEXT)).toBe("renamed-before-close");
			await repo.close(BACKGROUND_CONTEXT);
		});
	});
});
