/**
 * Deleting a session through the session selector removes that session's sidecars from its session folder: its
 * extension state files and its resident blobs (senpi#6445's queue delta review). They are named by the session id,
 * so they outlived the file. A move that brought the same session back then met the old ones: the import's commit
 * skips a sidecar whose destination already exists, so the session landed with the state it had when it left, and
 * an extension the returning bundle does not list kept state the session no longer has.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { deleteSessionFile } from "../../src/modes/interactive/components/session-selector.ts";
import { REPO, root, SESSION_ID, writeSession } from "./session-move-fixture.ts";

const AWAY = "move-away-1" as MoveId;
const BACK = "move-back-1" as MoveId;
const OTHER_SESSION = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d4";
const readIdentity = async () => REPO;

const stateFile = (sessionDir: string, extension: string, sessionId = SESSION_ID) =>
	join(sessionDir, "extensions", extension, `${sessionId}.json`);

function writeState(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

const textOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "absent");

async function movedAwayDeletedAndBack(changeOnB: (sessionDirB: string) => void) {
	const base = root();
	const cwdA = join(base, "a", "repo");
	const cwdB = join(base, "b", "repo");
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	const onA = writeSession(cwdA);
	const dirA = getDefaultSessionDir(cwdA);
	writeState(stateFile(dirA, "todo"), '{"todo":"buy milk"}\n');

	const away = join(base, "bundle-away");
	await exportSessionForMove({
		sessionFile: onA,
		moveId: AWAY,
		target: "device-b",
		droppedUserMessages: [],
		bundleDir: away,
	});
	const ledgerB = new MoveLedger(join(base, "ledger-b"));
	await ledgerB.prepare(AWAY);
	const onB = await importMovedSession({ bundleDir: away, targetCwd: cwdB, ledger: ledgerB, readIdentity });
	await finishMove({ sessionFile: onA, bundleDir: away, moveId: AWAY, answer: { state: "accepted" } });

	const deleted = await deleteSessionFile(onA);
	const leftAfterDelete = { goal: textOf(stateFile(dirA, "goal")), todo: textOf(stateFile(dirA, "todo")) };

	changeOnB(dirname(onB.sessionFile));
	const back = join(base, "bundle-back");
	await exportSessionForMove({
		sessionFile: onB.sessionFile,
		moveId: BACK,
		target: "device-a",
		droppedUserMessages: [],
		bundleDir: back,
	});
	const ledgerA = new MoveLedger(join(base, "ledger-a"));
	await ledgerA.prepare(BACK);
	const answer = await importMovedSession({ bundleDir: back, targetCwd: cwdA, ledger: ledgerA, readIdentity }).then(
		() => "taken",
		(error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`,
	);

	return {
		deleted: deleted.ok,
		leftAfterDelete,
		answer,
		landed: existsSync(join(dirA, basename(onA))),
		goal: textOf(stateFile(dirA, "goal")),
		todo: textOf(stateFile(dirA, "todo")),
	};
}

describe("deleting a session from the selector removes its sidecars (senpi#6445 queue delta)", () => {
	it("#given two sessions in one folder, each with an extension state file and resident blobs #when one is deleted #then its state file and blobs are gone and the other session's are untouched", async () => {
		const cwd = join(root(), "repo");
		mkdirSync(cwd, { recursive: true });
		const session = writeSession(cwd);
		const sessionDir = getDefaultSessionDir(cwd);
		const blobs = (sessionId: string) => join(sessionDir, "resident-blobs", sessionId, "blob-1");
		writeState(blobs(SESSION_ID), "blob of the deleted session");
		writeState(stateFile(sessionDir, "goal", OTHER_SESSION), '{"goal":"another session"}\n');
		writeState(blobs(OTHER_SESSION), "blob of another session");

		const result = await deleteSessionFile(session);

		expect({
			deleted: result.ok,
			file: existsSync(session),
			goal: textOf(stateFile(sessionDir, "goal")),
			blobs: existsSync(join(sessionDir, "resident-blobs", SESSION_ID)),
			otherGoal: textOf(stateFile(sessionDir, "goal", OTHER_SESSION)),
			otherBlob: textOf(blobs(OTHER_SESSION)),
		}).toEqual({
			deleted: true,
			file: false,
			goal: "absent",
			blobs: false,
			otherGoal: '{"goal":"another session"}\n',
			otherBlob: "blob of another session",
		});
	});

	it("#given a session that moved away and whose read-only copy was deleted here #when it moves back with a changed goal #then the import is taken and the goal that lands is the bundle's", async () => {
		const outcome = await movedAwayDeletedAndBack((sessionDirB) => {
			writeFileSync(stateFile(sessionDirB, "goal"), '{"goal":"a changed goal"}\n');
		});

		expect(outcome).toEqual({
			deleted: true,
			leftAfterDelete: { goal: "absent", todo: "absent" },
			answer: "taken",
			landed: true,
			goal: '{"goal":"a changed goal"}\n',
			todo: '{"todo":"buy milk"}\n',
		});
	});

	it("#given the same session, whose todo list was cleared on the other device so the returning bundle does not list it #when it moves back #then no todo state of the deleted copy is left for it", async () => {
		const outcome = await movedAwayDeletedAndBack((sessionDirB) => {
			rmSync(stateFile(sessionDirB, "todo"));
		});

		expect(outcome).toEqual({
			deleted: true,
			leftAfterDelete: { goal: "absent", todo: "absent" },
			answer: "taken",
			landed: true,
			goal: '{"goal":"ship"}\n',
			todo: "absent",
		});
	});
});
