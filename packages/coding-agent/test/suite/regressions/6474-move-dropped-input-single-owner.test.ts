/**
 * senpi#6474 / senpi#3962 review follow-up: the queued input a `move` release takes out of the session has exactly
 * one durable owner whatever the release answers. A release refused before its seal hands that input back in the
 * refusal, so the move must not also carry it; and the release's record belongs to one session, so two sessions in
 * one folder released under the same move id never answer, or take back, each other's input.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { droppedInputRecordPath } from "../../../src/core/session-move/dropped-input-record.ts";
import { parseMoveId } from "../../../src/core/session-move/bundle.ts";
import { startReleaseHost } from "../rpc-release-host-support.ts";
import {
	customTypes,
	failSealWrite,
	finishDeclined,
	queuedMoveRelease,
	releaseForMove,
	requeuedLines,
	sessionWithQueuedInput,
} from "./6474-move-release-support.ts";

const noExtension: ExtensionFactory = () => {};

describe("queued input a move release took out has exactly one owner", () => {
	it("#given a move release refused before its seal #when the same move is released again and finished declined #then the input the refusal handed back is neither answered nor re-queued again (senpi#6474, senpi#3962)", async () => {
		await using host = await startReleaseHost(noExtension);
		const { sessionId, sessionPath, session } = await sessionWithQueuedInput(host, "refused", "USER QUEUED TEXT");
		const failing = failSealWrite(session);
		const refused = await releaseForMove(host, sessionId, "move-refused");
		failing.restore();
		// The refusal hands the drained input to the caller: from here the caller owns it.
		expect(refused).toMatchObject({
			success: false,
			error: "release_failed",
			errorData: { interrupted: true, dropped: { user_messages: ["USER QUEUED TEXT"] } },
		});

		const released = await releaseForMove(host, sessionId, "move-refused", "rel2", false);
		expect(released).toMatchObject({ success: true, data: { dropped: { user_messages: [] } } });
		expect(await finishDeclined(host, sessionPath, "move-refused")).toMatchObject({
			success: true,
			data: { ownership: "writable" },
		});
		expect(requeuedLines(sessionPath, "move-refused")).toEqual([]);
	});

	it("#given two sessions in one folder released under the same move id #then each answers and takes back only its own queued input (senpi#6474)", async () => {
		await using host = await startReleaseHost(noExtension);
		const a = await queuedMoveRelease(host, "first", "move-shared", "FIRST SESSION TEXT");
		const b = await queuedMoveRelease(host, "second", "move-shared", "SECOND SESSION TEXT");
		expect(dirname(a.sessionPath)).toBe(dirname(b.sessionPath));
		expect(a.released).toMatchObject({ data: { dropped: { user_messages: ["FIRST SESSION TEXT"] } } });
		expect(b.released).toMatchObject({ data: { dropped: { user_messages: ["SECOND SESSION TEXT"] } } });

		await finishDeclined(host, a.sessionPath, "move-shared");
		const firstBack = requeuedLines(a.sessionPath, "move-shared");
		expect(firstBack).toHaveLength(1);
		expect(firstBack[0]).toContain("FIRST SESSION TEXT");

		// The first session's finish removed only its own record: the second still takes its input back.
		await finishDeclined(host, b.sessionPath, "move-shared", "fin2");
		const secondBack = requeuedLines(b.sessionPath, "move-shared");
		expect(secondBack).toHaveLength(1);
		expect(secondBack[0]).toContain("SECOND SESSION TEXT");
	});

	it("#given a release whose durable record cannot be written #then the refusal alone carries the drained input, no partial record is left, and the move never owes it too (senpi#6474, senpi#3962)", async () => {
		await using host = await startReleaseHost(noExtension);
		const { sessionId, sessionPath } = await sessionWithQueuedInput(host, "wedge", "USER QUEUED TEXT");
		// A directory where the record must land makes the record's own write fail, after the interrupt drained the
		// queue and the extensions staged their state: the fault is at the durable-write boundary, nowhere earlier.
		const recordPath = droppedInputRecordPath(sessionPath, parseMoveId("move-wedge"));
		await mkdir(recordPath, { recursive: true });

		const refused = await releaseForMove(host, sessionId, "move-wedge");

		expect(refused).toMatchObject({
			success: false,
			error: "release_failed",
			errorData: { interrupted: true, dropped: { user_messages: ["USER QUEUED TEXT"] } },
		});
		expect((refused.errorData as { detail: string }).detail).toContain(basename(recordPath));
		expect(await readdir(dirname(recordPath))).toEqual([basename(recordPath)]);
		expect(customTypes(sessionPath)).toEqual([]);

		// Once the wedge is gone the same move releases cleanly, and the input the refusal handed back is not owed.
		await rm(recordPath, { recursive: true });
		const released = await releaseForMove(host, sessionId, "move-wedge", "rel2", false);
		expect(released).toMatchObject({ success: true, data: { dropped: { user_messages: [] } } });
		await finishDeclined(host, sessionPath, "move-wedge");
		expect(requeuedLines(sessionPath, "move-wedge")).toEqual([]);
	});
});
