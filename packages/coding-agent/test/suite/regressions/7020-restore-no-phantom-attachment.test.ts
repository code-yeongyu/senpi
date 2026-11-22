/**
 * senpi#7020: a successor host restores the sessions its predecessor parked with no client asking for them. Every
 * restored session still counted one attachment that no connection owned and nothing could ever release, so the
 * listing showed `attachments: 1` with no client and `host session close` answered `closed: false, attachments: 1`
 * for each of them, forever. A restore attaches nobody: the session starts at 0, and a client's attach counts 1.
 */
import { afterEach, expect, it } from "vitest";
import {
	cleanupParkHosts,
	type ParkHost,
	parkedEntry,
	parkHost,
	parkScratch,
	reopenOnSuccessor,
} from "./7020-live-park-support.ts";

afterEach(cleanupParkHosts);

/** A retained session one host parked on its idle sweep, restored by the next host on the same daemon dir. */
async function restored(): Promise<{ successor: ParkHost; sessionPath: string; dir: string }> {
	const { dir, daemonDir, sessionPath } = await parkScratch();
	const host = await parkHost(dir, daemonDir);
	await host.open(sessionPath);
	await host.idleSweep();
	return {
		successor: await reopenOnSuccessor(dir, daemonDir, await parkedEntry(daemonDir, sessionPath)),
		sessionPath,
		dir,
	};
}

const attachments = (host: ParkHost): number | undefined => host.registry.list()[0]?.attachments;

it("lists a restored session with no attachment", async () => {
	const { successor } = await restored();
	expect(successor.registry.list()).toHaveLength(1);
	expect(attachments(successor)).toBe(0);
});

it("closes a restored session for the client that attaches to it and closes it", async () => {
	const { successor, sessionPath, dir } = await restored();
	await successor.send({ type: "open_session", sessionPath, cwd: dir, retain_on_disconnect: true }, "viewer");
	const sessionId = successor.registry.list()[0]?.sessionId;
	if (sessionId === undefined) throw new Error("the restored session is not listed");
	expect(attachments(successor)).toBe(1);

	await successor.send({ type: "close_session", id: "close", sessionId }, "viewer");
	expect(successor.registry.list()).toEqual([]);
});

it("counts each client that attaches, and keeps the session for the one still attached", async () => {
	const { successor, sessionPath, dir } = await restored();
	const open = { type: "open_session", sessionPath, cwd: dir, retain_on_disconnect: true } as const;
	await successor.send(open, "first");
	const sessionId = successor.registry.list()[0]?.sessionId;
	if (sessionId === undefined) throw new Error("the restored session is not listed");
	expect(attachments(successor)).toBe(1);
	// A connection that never attached owns nothing to close.
	expect(await successor.send({ type: "close_session", id: "stranger", sessionId }, "stranger")).toMatchObject({
		success: false,
		error: "unknown_session",
	});
	await successor.send(open, "second");
	expect(attachments(successor)).toBe(2);

	await successor.send({ type: "close_session", id: "second-close", sessionId }, "second");
	expect(successor.registry.list()).toEqual([expect.objectContaining({ sessionId, attachments: 1 })]);
	await successor.send({ type: "close_session", id: "first-close", sessionId }, "first");
	expect(successor.registry.list()).toEqual([]);
});
