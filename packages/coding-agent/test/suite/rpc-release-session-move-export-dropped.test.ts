/**
 * senpi#6267 (P1), senpi#3962: an interrupting release takes queued user input out of the session and hands it back
 * in `dropped.user_messages`. With the export in the same answer, the bundle records that input, so it survives a
 * lost answer: a later `finish` declined re-queues it from the kept bundle, once. An export of the same move sent
 * again without `droppedUserMessages` keeps what the kept bundle records instead of erasing it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { heldTurn, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

const MOVE = "move-dropped-1";
const noExtension: ExtensionFactory = () => {};

/** The input a finished move queued again in the session's journal: its records carry the move's own stable ids. */
const requeuedBy = (file: string, moveId: string): string[] =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					customType?: string;
					data?: { input?: { clientMessageId?: string; text?: string }; result?: { outcome?: string } };
				},
		)
		.filter(
			(entry) =>
				entry.customType === "pending_input_transition" &&
				entry.data?.result?.outcome === "admitted" &&
				entry.data.input?.clientMessageId?.startsWith(`move:${moveId}:`) === true,
		)
		.map((entry) => entry.data?.input?.text ?? "");

const droppedIn = (bundleDir: string) =>
	(JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as { droppedUserMessages: string[] })
		.droppedUserMessages;

describe("queued input a move release takes out (senpi#6267 P1, senpi#3962)", () => {
	it("#given a turn running with a follow-up queued behind it #when the session is released for a move with interrupt and an export, and the answer is lost #then the bundle records the follow-up, an export sent again without droppedUserMessages keeps it, and finish declined queues it once", async () => {
		await using host = await startReleaseHost(noExtension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("queued-follow-up");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		await host.send({ type: "follow_up", id: "f", sessionId, message: "USER FOLLOW TEXT" });

		const released = await host.send({
			type: "release_session",
			id: "release-move",
			sessionId,
			reason: "move",
			moveId: MOVE,
			target: "device-b",
			interrupt: true,
			export: {},
		});
		const answered = (released.data as { export: { ok: boolean; data: { bundle_dir: string } } }).export;
		expect(answered.ok).toBe(true);
		expect(droppedIn(answered.data.bundle_dir)).toEqual(["USER FOLLOW TEXT"]);

		const again = await host.send({
			type: "move_session",
			id: "export-again",
			op: "export",
			sessionPath,
			moveId: MOVE,
			target: "device-b",
		});
		expect(again.success).toBe(true);
		expect(droppedIn(answered.data.bundle_dir)).toEqual(["USER FOLLOW TEXT"]);

		const finished = await host.send({
			type: "move_session",
			id: "finish-declined",
			op: "finish",
			sessionPath,
			moveId: MOVE,
			answer: { state: "declined", reason: "cancelled" },
		});
		expect((finished.data as { ownership: string }).ownership).toBe("writable");
		expect(requeuedBy(sessionPath, MOVE)).toEqual(["USER FOLLOW TEXT"]);
	});
});
