import { describe, expect, it } from "vitest";
import { type DurableStore, DurableStoreError } from "../../src/durable/store.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import {
	openSessionStore,
	openSyncSessionStore,
	SessionStoreError,
	type StoredEntry,
} from "../../src/durable/session-store.ts";

const HEADER = { type: "session", id: "s1", version: 3 };
const entry = (key: string): StoredEntry => ({ key, line: JSON.stringify({ type: "message", id: key }) });

async function claimedMedium() {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	return medium;
}

describe("the session store over a DurableStore", () => {
	it("appends synchronously and a fresh store instance reads the session back in order", async () => {
		const medium = await claimedMedium();
		const session = await openSyncSessionStore(openMemoryStore(medium), 1).open("s1", HEADER);

		session.appendSync([entry("a"), entry("b")]);
		session.appendSync([entry("c")]);

		const reread = await openSessionStore(openMemoryStore(medium), 1).load("s1");
		expect(reread).toEqual({ id: "s1", header: HEADER, entries: [entry("a"), entry("b"), entry("c")] });
	});

	it("rewrites to exactly the given entries", async () => {
		const medium = await claimedMedium();
		const session = await openSyncSessionStore(openMemoryStore(medium), 1).open("s1", HEADER);
		session.appendSync([entry("a"), entry("b"), entry("c")]);

		session.rewriteSync({ ...HEADER, version: 4 }, [entry("a"), entry("d")]);

		expect(await openSessionStore(openMemoryStore(medium), 1).load("s1")).toEqual({
			id: "s1",
			header: { ...HEADER, version: 4 },
			entries: [entry("a"), entry("d")],
		});
		expect((await openMemoryStore(medium).scanDocuments("")).map((document) => document.key)).not.toContain(
			"session-import/entry/s1/b",
		);
	});

	it("throws a refused append on the same call and keeps the session and the store unchanged", async () => {
		const medium = await claimedMedium();
		const session = await openSyncSessionStore(openMemoryStore(medium), 1).open("s1", HEADER);
		session.appendSync([entry("a")]);
		await openMemoryStore(medium).claim(1, 2);
		const before = await openMemoryStore(medium).exportSnapshot();

		expect(() => session.appendSync([entry("b")])).toThrow(DurableStoreError);

		expect(session.entries()).toEqual([entry("a")]);
		expect(await openMemoryStore(medium).exportSnapshot()).toEqual(before);
	});

	it("refuses an entry key the session already holds before anything is committed", async () => {
		const medium = await claimedMedium();
		const session = await openSyncSessionStore(openMemoryStore(medium), 1).open("s1", HEADER);
		session.appendSync([entry("a")]);
		const before = await openMemoryStore(medium).exportSnapshot();

		expect(() => session.appendSync([entry("b"), entry("a")])).toThrow(SessionStoreError);
		expect(await openMemoryStore(medium).exportSnapshot()).toEqual(before);
	});

	it("offers the same session on an async-only store, with no sync writes", async () => {
		const medium = await claimedMedium();
		const store: DurableStore = openMemoryStore(medium);
		const session = await openSessionStore(store, 1).open("s1", HEADER);

		await session.append([entry("a")]);

		expect(await openSessionStore(openMemoryStore(medium), 1).load("s1")).toEqual({
			id: "s1",
			header: HEADER,
			entries: [entry("a")],
		});
	});

	it("keeps both of two overlapping async appends, in call order", async () => {
		const medium = await claimedMedium();
		const session = await openSessionStore(openMemoryStore(medium), 1).open("s1", HEADER);

		await Promise.all([session.append([entry("a")]), session.append([entry("b")])]);

		expect((await openSessionStore(openMemoryStore(medium), 1).load("s1"))?.entries).toEqual([
			entry("a"),
			entry("b"),
		]);
	});

	it("rejects, never throws, an async duplicate across two overlapping appends", async () => {
		const medium = await claimedMedium();
		const session = await openSessionStore(openMemoryStore(medium), 1).open("s1", HEADER);

		const first = session.append([entry("a")]);
		const second = session.append([entry("a")]);

		await expect(first).resolves.toBeUndefined();
		await expect(second).rejects.toBeInstanceOf(SessionStoreError);
		expect((await openSessionStore(openMemoryStore(medium), 1).load("s1"))?.entries).toEqual([entry("a")]);
	});

	it("keeps an existing session's stored header; the open header applies only to a new session", async () => {
		const medium = await claimedMedium();
		const first = await openSyncSessionStore(openMemoryStore(medium), 1).open("s1", HEADER);
		expect(await openSessionStore(openMemoryStore(medium), 1).load("s1")).toBeUndefined();
		first.appendSync([entry("a")]);

		const reopened = await openSyncSessionStore(openMemoryStore(medium), 1).open("s1", { ...HEADER, version: 9 });

		expect(reopened.header()).toEqual(HEADER);
	});

	it("cannot build a sync session store on a backend without commitSync (compile-time)", () => {
		const compileTimeFailures = (asyncOnly: DurableStore) => {
			// @ts-expect-error a sync session store needs a SyncCommitStore; an async-only DurableStore has no commitSync
			void openSyncSessionStore(asyncOnly, 1);
		};
		void compileTimeFailures;
	});
});
