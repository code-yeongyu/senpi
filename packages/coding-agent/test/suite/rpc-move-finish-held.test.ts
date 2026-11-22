/**
 * senpi#6484, part 3: a `move_session` `finish` discards a request's bundle and staged state only for a file the move
 * held (an ownership entry for that move id of the file's own session), and answers `held_this_move`. For any other
 * writable file it answers `writable` as before and changes nothing: the staged state is per folder and move id, so a
 * finish naming another file of the folder used to erase what a release staged for the session it did seal.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { outgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import {
	type MoveId,
	SESSION_MOVED_IN,
	SESSION_RECLAIMED,
	SESSION_RELEASED,
} from "../../src/core/session-move/ownership.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import { bindingSettled, REPLACING_COMMANDS, replaceInSameFolder } from "./rpc-replacement-follow-support.ts";

type Wire = Record<string, unknown>;
type Host = Awaited<ReturnType<typeof startReleaseHost>>;
const send = (command: Wire): RpcCommand & { id: string } => command as unknown as RpcCommand & { id: string };
const MOVE = "move-x" as MoveId;
const ORDERS = ["sealed file first", "other file first"] as const;

function finish(host: Host, sessionPath: string, answer: Wire = { state: "receiving" }) {
	return host.send(
		send({ type: "move_session", id: `finish-${sessionPath}`, op: "finish", sessionPath, moveId: MOVE, answer }),
	);
}

/** A session written once and then unloaded: a writable file on disk that no handle of the host holds. */
async function writtenAndUnloaded(host: Host, name: string) {
	const opened = await host.open(name);
	const unloaded = await host.send(
		send({ type: "unload_session", id: `unload-${name}`, sessionId: opened.sessionId }),
	);
	if ((unloaded.data as Wire | undefined)?.outcome !== "unloaded") throw new Error(JSON.stringify(unloaded));
	return { file: opened.sessionPath, sessionId: opened.session.sessionId };
}

describe("finish for a file the move did not hold (senpi#6484, part 3)", () => {
	it.each(REPLACING_COMMANDS.flatMap((replacing) => ORDERS.map((order) => ({ replacing, order }))))(
		"after a move release that followed $replacing, a finish for the other, writable file changes nothing ($order)",
		async ({ replacing, order }) => {
			await using host = await startReleaseHost(gatewayFixture().extension);
			const { handle, old, next } = await replaceInSameFolder(host, replacing);
			await bindingSettled(host, handle);
			const released = await host.send(
				send({
					type: "release_session",
					id: "release",
					sessionId: handle,
					reason: "move",
					moveId: MOVE,
					target: "device-b",
				}),
			);
			expect(released).toMatchObject({ success: true });
			const staged = outgoingStateDir(next.sessionFile, MOVE);
			expect(existsSync(staged)).toBe(true);
			const otherBefore = readFileSync(old.sessionFile, "utf8");

			if (order === "sealed file first")
				expect(await finish(host, next.sessionFile)).toMatchObject({
					success: true,
					data: { ownership: "moving" },
				});
			expect(await finish(host, old.sessionFile)).toMatchObject({
				success: true,
				data: { ownership: "writable", held_this_move: false },
			});
			if (order === "other file first")
				expect(await finish(host, next.sessionFile)).toMatchObject({
					success: true,
					data: { ownership: "moving" },
				});

			expect(existsSync(staged)).toBe(true);
			expect(readFileSync(old.sessionFile, "utf8")).toBe(otherBefore);
		},
	);

	it.each([
		{ state: "declined", reason: "expired" },
		{ state: "failed", reason: "import_failed" },
	])("a $state finish for a file that was never sealed answers writable and changes nothing", async (answer) => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { file } = await writtenAndUnloaded(host, "never-sealed");
		const staged = outgoingStateDir(file, MOVE);
		mkdirSync(staged, { recursive: true });
		const before = readFileSync(file, "utf8");

		expect(await finish(host, file, answer)).toMatchObject({
			success: true,
			data: { ownership: "writable", held_this_move: false },
		});

		expect(existsSync(staged)).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("a file that inherited the move's entries from another session is not held by it", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { file } = await writtenAndUnloaded(host, "inherited");
		const manager = SessionManager.open(file);
		const another = { session_id: "another-session", move_id: MOVE };
		manager.appendCustomEntry(SESSION_RELEASED, { reason: "move", target: "device-b", ...another });
		manager.appendCustomEntry(SESSION_RECLAIMED, { reason: "declined", ...another });
		const staged = outgoingStateDir(file, MOVE);
		mkdirSync(staged, { recursive: true });

		expect(await finish(host, file)).toMatchObject({
			success: true,
			data: { ownership: "writable", held_this_move: false },
		});

		expect(existsSync(staged)).toBe(true);
	});

	it("a session that moved away under one move and came back under another is held by the first: its leftovers go", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { file, sessionId } = await writtenAndUnloaded(host, "came-back");
		const manager = SessionManager.open(file);
		manager.appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: MOVE,
			target: "device-b",
			session_id: sessionId,
		});
		manager.appendCustomEntry(SESSION_MOVED_IN, { move_id: MOVE, session_id: sessionId });
		manager.appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: "move-y",
			target: "device-a",
			session_id: sessionId,
		});
		manager.appendCustomEntry(SESSION_MOVED_IN, { move_id: "move-y", session_id: sessionId });
		const staged = outgoingStateDir(file, MOVE);
		mkdirSync(staged, { recursive: true });

		expect(await finish(host, file)).toMatchObject({
			success: true,
			data: { ownership: "writable", held_this_move: true },
		});

		expect(existsSync(staged)).toBe(false);
	});
});
