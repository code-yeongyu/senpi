import { expect, it } from "vitest";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";

// senpi#5576: a user bash run over RPC is persisted as a `bashExecution` entry, and every observer learns of it
// through `entry_appended` like any other persisted entry, while the issuing connection gets it exactly once.
const isBashEntry = (record: WireRecord): boolean =>
	record.type === "entry_appended" &&
	(record.entry as { message?: { role?: unknown } } | undefined)?.message?.role === "bashExecution";

it("publishes an RPC bash result as entry_appended to a mirror-all observer, once per connection", async () => {
	// Below the test budget, so a missing record fails by naming its predicate.
	await using rig = await statusHost({ deadlineMs: 15_000 });
	const owner = rig.client("owner");
	const observer = rig.client("observer");
	const sessionId = String(dataOf(await owner.request({ type: "open_session", cwd: rig.cwd })).sessionId);
	await observer.request({ type: "subscribe_sessions", mirror: "all", observe: true });

	const result = dataOf(await owner.request({ type: "bash", sessionId, command: "echo s5576-out" }));
	expect(result.output).toBe("s5576-out\n");
	const seen = await observer.waitFor(isBashEntry);
	const history = dataOf(await owner.request({ type: "get_entries", sessionId }));
	if (!Array.isArray(history.entries)) throw new Error("missing history");
	const rows = history.entries.filter(
		(entry: { message?: { role?: unknown } }) => entry.message?.role === "bashExecution",
	);
	expect(rows).toHaveLength(1);
	const [row] = rows;

	expect(seen.entry).toEqual(row);
	expect(seen.entry).toMatchObject({ id: row.id, message: { role: "bashExecution", output: "s5576-out\n" } });
	expect(observer.inbox.filter(isBashEntry)).toHaveLength(1);
	expect(owner.inbox.filter(isBashEntry).map((record) => (record.entry as { id: string }).id)).toEqual([row.id]);
});
