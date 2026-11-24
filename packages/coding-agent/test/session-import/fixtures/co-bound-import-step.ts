// One step of the co-bound import scenario in its own Bun process (bun:sqlite): `bun <file> <json args>` binds to the
// store file at its current epoch (claiming 0->1 only when fresh), runs one action, and prints one JSON result line.
import { openSyncSessionStore } from "../../../../agent/src/durable/session-store.ts";
import { createAdmissionLine } from "../../../../agent/src/durable/store-admission.ts";
import { openSqliteStore } from "../../../../session-backends/sqlite-bun/src/store.ts";
import { createJsonlImporter } from "../../../src/core/session-import/jsonl-import.ts";

const { database, action, path, key } = JSON.parse(process.argv[2] ?? "{}") as {
	database: string;
	action: "import" | "append" | "read";
	path?: string;
	key?: string;
};
const { store, db } = openSqliteStore(database);
let epoch = await store.readEpoch();
if (epoch === 0) {
	await store.claim(0, 1);
	epoch = 1;
}
const importer = createJsonlImporter({
	store,
	epoch,
	admission: createAdmissionLine(),
	now: () => Date.now() + 10_000,
});
if (action === "import" && path !== undefined) {
	console.log(JSON.stringify(await importer.importFile(path)));
} else if (action === "append" && key !== undefined) {
	const handle = await openSyncSessionStore(store, epoch).open("s", { type: "session", version: 3, id: "s" });
	handle.appendSync([{ key, line: JSON.stringify({ type: "custom", id: key, parentId: "a", customType: "peer" }) }]);
	console.log(JSON.stringify({ appended: key }));
} else {
	const session = await importer.getSession("s");
	console.log(JSON.stringify({ keys: (session?.entries ?? []).map((entry) => (entry as { id: string }).id) }));
}
db.close();
