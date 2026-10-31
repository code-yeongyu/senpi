import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmissionLine } from "../../../../agent/src/durable/store-admission.ts";
import { openSqliteStore } from "../../../../session-backends/sqlite-bun/src/store.ts";
import { createJsonlImporter, jsonlFiles, writeHatchMarker } from "../../../src/core/session-import/jsonl-import.ts";

// S07 / #4995: real SQLite close/reopen, not a fixture that emulates durable persistence.
async function main() {
	const root = await mkdtemp(join(tmpdir(), "s07-sqlite-"));
	const database = join(root, "store.sqlite");
	const path = join(root, "source.jsonl");
	const session = { type: "session", version: 3, id: "s", cwd: "/fixture", timestamp: "2026-01-01" };
	const a = { type: "custom", id: "a", parentId: null, timestamp: "2026-01-01", customType: "fixture", data: "a" };
	const b = { ...a, id: "b", parentId: "a", data: "b" };
	const contents = (entries: (typeof a | typeof b)[]) =>
		[session, ...entries].map((value) => JSON.stringify(value)).join("\n") + "\n";
	let connection = openSqliteStore(database);
	const importer = () =>
		createJsonlImporter({
			store: connection.store,
			epoch: 1,
			admission: createAdmissionLine(),
			now: () => Date.now() + 10_000,
		});
	try {
		await connection.store.claim(0, 1);
		await writeFile(path, contents([a]));
		await importer().importFile(path);
		connection.db.close();
		connection = openSqliteStore(database);
		await writeFile(path, contents([a, b]));
		assert.deepEqual(await importer().importFile(path), { outcome: "extended", sessionId: "s", imported: 1 });
		connection.db.close();
		connection = openSqliteStore(database);
		assert.deepEqual((await importer().getSession("s"))?.entries, [a, b]);
		await writeFile(path, contents([b]));
		await writeHatchMarker(path, await jsonlFiles.stat(path));
		const fork = await importer().importFile(path);
		connection.db.close();
		connection = openSqliteStore(database);
		assert.deepEqual((await importer().getSession("s"))?.entries, [a, b]);
		const forked = await importer().getSession(fork.sessionId);
		assert.deepEqual(forked?.entries, [b]);
		assert.equal(forked?.divergence?.kind, "k9f2");
		assert.equal(forked?.divergence?.parentSessionId, "s");
		assert.deepEqual(await importer().importFile(path), {
			outcome: "unchanged",
			sessionId: fork.sessionId,
			imported: 0,
		});
	} finally {
		connection.db.close();
		await rm(root, { recursive: true, force: true });
	}
}

await main();
