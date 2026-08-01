import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	createSqliteSessionSearch,
	createSqliteSessionStore,
	type SqliteSessionMetadata,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createJsonlSessionStore } from "../../src/harness/session/jsonl-store.ts";
import { createSessionRepository } from "../../src/harness/session/repository.ts";
import { createScanningSessionSearch } from "../../src/harness/session/search-backend.ts";
import type { SessionSearch, SessionSearchHit, SessionSearchOptions } from "../../src/harness/types.ts";
import { createTempDir, createUserMessage } from "./session-test-utils.ts";

const ownedStores: AsyncDisposable[] = [];

afterEach(async () => {
	for (const store of ownedStores.splice(0)) await store[Symbol.asyncDispose]();
});

function createSqliteRepository(options: Parameters<typeof createSqliteSessionStore>[0]) {
	const store = createSqliteSessionStore(options);
	ownedStores.push(store);
	return createSessionRepository({
		store,
		search: createSqliteSessionSearch(options),
	});
}

function createJsonlRepository(options: Parameters<typeof createJsonlSessionStore>[0]) {
	const store = createJsonlSessionStore(options);
	ownedStores.push(store);
	return createSessionRepository({ store, search: createScanningSessionSearch(store) });
}

describe("JsonlSessionStore with scanning search", () => {
	it("searches canonical session entries by scanning", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createJsonlRepository({ fs: env, sessionsRoot: join(root, "sessions") });
		const included = await repo.create({ cwd: root, id: "included" });
		const excluded = await repo.create({ cwd: `${root}/other`, id: "excluded" });
		const entryId = await included.appendMessage(createUserMessage("Find the auth defect"));
		await excluded.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "AUTH", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);
	});
});

describe("SqliteSessionStore with explicit SQLite FTS5 search", () => {
	it("uses SQLite FTS5 when composed with its search store", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
		const included = await repo.create({ cwd: root, id: "included" });
		const excluded = await repo.create({ cwd: `${root}/other`, id: "excluded" });
		const metadata = await included.getMetadata();
		const entryId = await included.appendMessage(createUserMessage("Find the auth defect"));
		await excluded.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);
		await expect(repo.search({ text: "uth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);

		const db = await sqlite.open(databasePath);
		try {
			const tables = await db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string }>();
			expect(tables.map((row) => row.name)).toContain("session_search_fts");
			expect(tables.map((row) => row.name)).not.toContain("session_search_records");
		} finally {
			await db.close();
		}

		await repo.delete(metadata);
		await expect(repo.search({ text: "auth", cwd: root })).resolves.toEqual([]);
	});

	it("creates an empty canonical session without initializing FTS", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			const fts = await db
				.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'session_search_fts'")
				.get<{ found: number }>();
			expect(fts).toBeUndefined();
		} finally {
			await db.close();
		}
		await expect(session.appendMessage(createUserMessage("still writable"))).resolves.toBeTypeOf("string");
	});

	it("rolls back canonical appends when co-located FTS trigger writes fail", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
		await repo.search({ text: "initialize" });
		const session = await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			await db.exec("DROP TABLE session_search_fts");
		} finally {
			await db.close();
		}

		await expect(session.appendMessage(createUserMessage("must roll back"))).rejects.toThrow();
		await expect(session.getEntries()).resolves.toEqual([]);
	});

	it("rolls back canonical deletion when co-located FTS cleanup fails", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		const repo = createSqliteRepository({ env, sqlite, databasePath });
		await repo.search({ text: "initialize" });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("must remain"));
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db.exec("DROP TABLE session_search_fts");
		} finally {
			await db.close();
		}

		await expect(repo.delete(metadata)).rejects.toThrow();
		const reopened = await repo.open(metadata);
		await expect(reopened.getEntries()).resolves.toHaveLength(1);
	});

	it("initializes canonical storage when searched before the first session is created", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = createSqliteRepository({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});

		await expect(repo.search({ text: "auth" })).resolves.toEqual([]);
		const session = await repo.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		await expect(repo.search({ text: "auth" })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "session-1" }) }),
		]);
		await expect(session.appendMessage(createUserMessage("Still writable"))).resolves.toBeTypeOf("string");
	});
});

describe("SqliteSessionStore with custom search", () => {
	it("can swap out the default search implementation", async () => {
		const root = createTempDir();
		const searches: SessionSearchOptions[] = [];
		const search: SessionSearch<SqliteSessionMetadata> = {
			async search(options): Promise<SessionSearchHit<SqliteSessionMetadata>[]> {
				searches.push(options);
				return [];
			},
		};
		const env = new NodeExecutionEnv({ cwd: root });
		const store = createSqliteSessionStore({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		const repo = createSessionRepository({ store, search });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("stored canonically"));

		await expect(repo.search({ text: "custom query" })).resolves.toEqual([]);
		expect(searches).toEqual([{ text: "custom query" }]);
	});
});
