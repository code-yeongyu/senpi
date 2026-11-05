// Child process for co-bound-session.test.ts: `bun <file> <json args>` opens one sqlite-bun medium, binds at its
// current epoch (claiming 0->1 only when fresh), prints {"ready":true}, waits for one stdin line, appends, prints.
import { DurableStoreError } from "../../../../agent/src/durable/store.ts";
import { openSyncSessionStore } from "../../../../agent/src/durable/session-store.ts";
import { createBunSqliteMedia } from "../../src/index.ts";

const { root, medium, sessionId, tag, count, read } = JSON.parse(process.argv[2] ?? "{}") as {
	root: string;
	medium: string;
	sessionId: string;
	tag: string;
	count: number;
	read?: boolean;
};
const say = (value: object): void => console.log(JSON.stringify(value));
const store = await createBunSqliteMedia(root).open(medium);
let epoch = await store.readEpoch();
if (epoch === 0) {
	try {
		await store.claim(0, 1);
		epoch = 1;
	} catch (error) {
		if (!(error instanceof DurableStoreError) || error.code !== "stale-epoch") throw error;
		epoch = await store.readEpoch();
	}
}
const handle = await openSyncSessionStore(store, epoch).open(sessionId, { type: "session", version: 3, id: sessionId });
if (read === true) {
	say({ keys: handle.entries().map((entry) => entry.key) });
} else {
	say({ ready: true });
	for await (const _line of Bun.stdin.stream()) break;
	for (let index = 0; index < count; index++) {
		const key = `${tag}-${index}`;
		handle.appendSync([{ key, line: JSON.stringify({ type: "custom", id: key }) }]);
	}
	say({ ok: true });
}
