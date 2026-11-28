/**
 * senpi#6474 / senpi#3962: `release_session` (reason `move`, `interrupt: true`) takes the queued user input out of
 * the session and answers it as `dropped.user_messages`. Until the move's export writes its manifest, that answer was
 * the input's only copy: an export that fails before its manifest (senpi#6474), or an answer the caller never
 * received (senpi#3962), left `move_session finish` nothing to re-queue, so a session taken back came back writable
 * with an empty queue. The release now records what it took under the move id in the outgoing move-state folder,
 * `finish` re-queues from that record when no bundle manifest exists, a second release of the same move answers the
 * recorded input again (senpi#3962's idempotent release), and the record outranks a manifest that carries less than
 * the release drained - all under the per-move client message ids `requeueInput` already uses, so the input returns
 * exactly once.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { startReleaseHost } from "../rpc-release-host-support.ts";
import { customTypes, queuedMoveRelease, requeuedLines } from "./6474-move-release-support.ts";

const noExtension: ExtensionFactory = () => {};

/** How many times `finish` re-queued the input under the per-move client message ids. */
const requeuedAs = (file: string, moveId: string) => requeuedLines(file, moveId).length;

describe("queued input a move release took out is not lost before the export's manifest", () => {
	it("#given an answered move release #when the export fails before it writes its manifest and the move is finished declined #then the session is taken back with its queued input exactly once (senpi#6474)", async () => {
		await using host = await startReleaseHost(noExtension);
		const { sessionPath, released } = await queuedMoveRelease(host, "pre-manifest", "move-6474");
		expect(released).toMatchObject({
			success: true,
			data: { dropped: { user_messages: ["USER QUEUED TEXT"] } },
		});

		// The outgoing folder cannot be written (a full or read-only disk), so the export fails before its
		// manifest, even though the caller passes the messages the release handed back.
		const outgoing = join(host.agentDir, "session-moves", "outgoing");
		await mkdir(dirname(outgoing), { recursive: true });
		await writeFile(outgoing, "");
		const failed = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-6474",
			target: "device-b",
			droppedUserMessages: ["USER QUEUED TEXT"],
		});
		expect(failed).toMatchObject({ success: false, error: "move_failed" });

		// The disk problem clears, the caller gives the session back, and the move ends declined.
		await rm(outgoing);
		const finished = await host.send({
			type: "move_session",
			id: "fin",
			op: "finish",
			sessionPath,
			moveId: "move-6474",
			answer: { state: "declined", reason: "cancelled" },
		});

		expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(customTypes(sessionPath)).toEqual(["session_released", "session_reclaimed"]);
		expect(requeuedAs(sessionPath, "move-6474")).toBe(1);
	});

	it("#given a move release whose answer never reached the caller #when the move is finished declined #then the session is taken back with its queued input exactly once (senpi#3962)", async () => {
		await using host = await startReleaseHost(noExtension);
		const { sessionPath } = await queuedMoveRelease(host, "lost-answer", "move-3962");
		// The answer is lost: the caller never sees `dropped.user_messages`, so it has nothing to hand to the export.
		// All it learns is that the receiver is not taking the session, and it gives the session back.

		const finished = await host.send({
			type: "move_session",
			id: "fin",
			op: "finish",
			sessionPath,
			moveId: "move-3962",
			answer: { state: "declined", reason: "cancelled" },
		});

		expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(requeuedAs(sessionPath, "move-3962")).toBe(1);

		// A second finish is the crash replay of the first: still exactly once.
		await host.send({
			type: "move_session",
			id: "fin2",
			op: "finish",
			sessionPath,
			moveId: "move-3962",
			answer: { state: "declined", reason: "cancelled" },
		});
		expect(requeuedAs(sessionPath, "move-3962")).toBe(1);
	});

	it("#given a move release whose answer was lost #when the session is released again for the same move #then the answer returns the same dropped messages and a declined finish re-queues them exactly once (senpi#3962)", async () => {
		const exported: string[] = [];
		await using host = await startReleaseHost((pi) => {
			pi.on("session_move_export", (event) => {
				exported.push(event.moveId);
			});
		});
		const { sessionPath } = await queuedMoveRelease(host, "same-id-release", "move-3962-again");
		// The first answer never reached the caller. It reopens the session and asks again under the same move id,
		// which must answer the same dropped messages instead of an empty queue.

		const reopened = await host.attach(sessionPath, "again");
		expect(reopened).toMatchObject({ success: true });
		const releasedAgain = await host.send(
			{
				type: "release_session",
				id: "rel2",
				sessionId: (reopened.data as { sessionId: string }).sessionId,
				reason: "move",
				moveId: "move-3962-again",
				target: "device-b",
			},
			"again",
		);

		expect(releasedAgain).toMatchObject({
			success: true,
			data: { dropped: { user_messages: ["USER QUEUED TEXT"] } },
		});
		expect(exported).toEqual(["move-3962-again"]);
		const finished = await host.send({
			type: "move_session",
			id: "fin",
			op: "finish",
			sessionPath,
			moveId: "move-3962-again",
			answer: { state: "declined", reason: "cancelled" },
		});
		expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(requeuedAs(sessionPath, "move-3962-again")).toBe(1);
	});

	it("#given a move release whose answer was lost #when the caller exports with no messages to pass #then the manifest carries the recorded input and a declined finish re-queues it exactly once (senpi#3962)", async () => {
		await using host = await startReleaseHost(noExtension);
		const { sessionPath } = await queuedMoveRelease(host, "authoritative-export", "move-3962-empty");
		// The answer is lost, so the caller has no messages to hand the export; the recorded input must still travel.

		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-3962-empty",
			target: "device-b",
		});
		expect(exported).toMatchObject({ success: true });
		const manifestPath = join((exported.data as { bundle_dir: string }).bundle_dir, "manifest.json");
		expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
			droppedUserMessages: ["USER QUEUED TEXT"],
		});

		const finished = await host.send({
			type: "move_session",
			id: "fin",
			op: "finish",
			sessionPath,
			moveId: "move-3962-empty",
			answer: { state: "declined", reason: "cancelled" },
		});
		expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(requeuedAs(sessionPath, "move-3962-empty")).toBe(1);
	});

	it("#given a recorded take and a manifest an older build emptied #when the move is finished declined #then the record outranks the manifest and the input is re-queued exactly once (senpi#6474, senpi#3962)", async () => {
		await using host = await startReleaseHost(noExtension);
		const { sessionPath } = await queuedMoveRelease(host, "empty-manifest", "move-empty-manifest");
		// An older build (or any writer) produced a manifest whose dropped input is empty although the release
		// recorded one; the record is the engine's own memory of what it drained, so it decides.

		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-empty-manifest",
			target: "device-b",
		});
		expect(exported).toMatchObject({ success: true });
		const manifestPath = join((exported.data as { bundle_dir: string }).bundle_dir, "manifest.json");
		await writeFile(
			manifestPath,
			JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), droppedUserMessages: [] }),
		);

		const finished = await host.send({
			type: "move_session",
			id: "fin",
			op: "finish",
			sessionPath,
			moveId: "move-empty-manifest",
			answer: { state: "declined", reason: "cancelled" },
		});
		expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(requeuedAs(sessionPath, "move-empty-manifest")).toBe(1);
	});

	it("#given an answered move release #when the export is refused because the session was reopened here #then a close and a declined finish take the session back with its queued input exactly once (senpi#6474)", async () => {
		await using host = await startReleaseHost(noExtension);
		const { sessionPath, released } = await queuedMoveRelease(host, "refused-export", "move-6474-open");
		expect(released).toMatchObject({
			success: true,
			data: { dropped: { user_messages: ["USER QUEUED TEXT"] } },
		});

		// The session is opened on A again between the release and the export, so the export is refused
		// `session_open_here` before it writes its manifest, even though the caller passes the messages back.
		const reopened = await host.attach(sessionPath, "reopen");
		expect(reopened).toMatchObject({ success: true });
		const refused = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "move-6474-open",
			target: "device-b",
			droppedUserMessages: ["USER QUEUED TEXT"],
		});
		expect(refused).toMatchObject({ success: false, error: "session_open_here" });

		// The refusal tells the caller to close the session here; only then may the move finish.
		await host.send(
			{ type: "close_session", id: "close", sessionId: (reopened.data as { sessionId: string }).sessionId },
			"reopen",
		);
		const finished = await host.send({
			type: "move_session",
			id: "fin",
			op: "finish",
			sessionPath,
			moveId: "move-6474-open",
			answer: { state: "declined", reason: "cancelled" },
		});
		expect(finished).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(requeuedAs(sessionPath, "move-6474-open")).toBe(1);
	});
});
