import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { MoveBundleInvalidError } from "../../src/core/session-move/bundle.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { answerMoveStatus, importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveFencedError, MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import {
	type MoveId,
	SESSION_MOVED,
	SESSION_MOVED_IN,
	SESSION_RECLAIMED,
	SESSION_RELEASED,
	SessionMovedAwayError,
} from "../../src/core/session-move/ownership.ts";
import { admittedInputs, appendUserMessage, customTypes, MOVE, SESSION_ID, setup } from "./session-move-fixture.ts";

/** The session file a receive in these tests lands as. */
const LANDING = "/sessions/landing.jsonl";

const BACK = "move-0002" as MoveId;

function editManifest(bundleDir: string, edit: (manifest: Record<string, unknown>) => void): void {
	const file = join(bundleDir, "manifest.json");
	const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	edit(manifest);
	writeFileSync(file, JSON.stringify(manifest));
}

describe("session move review fixes (senpi#3631)", () => {
	it("#given a bundle whose session file name climbs out of the session folder #then the import refuses it and touches nothing", async () => {
		const { base, cwdA, cwdB, bundleDir, ledger, readIdentity } = await setup();
		const before = readdirSync(getDefaultSessionDir(cwdA));
		for (const name of ["../../../escaped.jsonl", "..\\..\\escaped.jsonl", "sub/x.jsonl", ".hidden.jsonl"]) {
			editManifest(bundleDir, (manifest) => {
				manifest.sessionFileName = name;
			});
			await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
				MoveBundleInvalidError,
			);
		}
		expect(readdirSync(getDefaultSessionDir(cwdA))).toEqual(before);
		expect(existsSync(join(base, "escaped.jsonl"))).toBe(false);
	});

	it("#given a bundle whose move id or session id is not a plain id #then the import refuses it before touching any folder", async () => {
		const { base, cwdB, bundleDir, ledger, readIdentity } = await setup();
		const sessionDir = getDefaultSessionDir(cwdB);
		mkdirSync(sessionDir, { recursive: true });
		const victim = join(sessionDir, "victim.jsonl");
		writeFileSync(victim, "{}\n");
		const bad = ["..", ".", "../x", "..\\x", "/abs", "C:\\abs", "a/b", "a\\b", "nul\u0000id", "", "x".repeat(200)];
		for (const key of ["moveId", "sessionId"] as const) {
			for (const value of bad) {
				editManifest(bundleDir, (manifest) => {
					manifest.moveId = MOVE;
					manifest.sessionId = SESSION_ID;
					manifest[key] = value;
				});
				await expect(
					importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity }),
				).rejects.toBeInstanceOf(MoveBundleInvalidError);
			}
		}
		expect(existsSync(victim)).toBe(true);
		expect(existsSync(join(sessionDir, ".move-staging"))).toBe(false);
		expect(readdirSync(base)).not.toContain("x");
	});

	it("#given a bundle whose session id differs from the session file's own header #then the import refuses it", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		editManifest(bundleDir, (manifest) => {
			manifest.sessionId = "0197f6e4-0000-7000-8000-000000000000";
		});
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveBundleInvalidError,
		);
	});

	it("#given a move id that is not a plain id #then export refuses it", async () => {
		const { base, cwdA } = await setup();
		const other = join(getDefaultSessionDir(cwdA), `2026-10-18T00-00-00-000Z_${SESSION_ID}.jsonl`);
		await expect(
			exportSessionForMove({
				sessionFile: other,
				moveId: "../evil" as MoveId,
				target: "device-b",
				droppedUserMessages: [],
				bundleDir: join(base, "bundle-evil"),
			}),
		).rejects.toBeInstanceOf(MoveBundleInvalidError);
	});

	it("#given a listed bundle path with Windows separators that leaves the bundle #then the bundle is invalid", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		editManifest(bundleDir, (manifest) => {
			manifest.sidecars = [{ path: "files\\..\\..\\outside.json", sha256: "0".repeat(64) }];
		});
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveBundleInvalidError,
		);
	});

	it("#given a bundle with a payload kind this version does not know #then the import refuses it", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		editManifest(bundleDir, (manifest) => {
			manifest.payloads = [{ kind: "workspace-folder", files: [] }];
		});
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveBundleInvalidError,
		);
	});

	it("#given a session being moved #then a takeover release or a stray ownership entry cannot make it writable", async () => {
		const { source } = await setup();
		const manager = SessionManager.open(source);
		expect(() => manager.appendCustomEntry(SESSION_RELEASED, { reason: "takeover" })).toThrow(SessionMovedAwayError);
		expect(() => manager.appendCustomEntry(SESSION_MOVED_IN, { move_id: "other", session_id: SESSION_ID })).toThrow(
			SessionMovedAwayError,
		);
		expect(() => manager.appendCustomEntry(SESSION_RECLAIMED, { move_id: "other", session_id: SESSION_ID })).toThrow(
			SessionMovedAwayError,
		);
		expect(() => appendUserMessage(source, "after the attempts")).toThrow(SessionMovedAwayError);
	});

	it("#given a session that arrived elsewhere #then nothing can reopen it here", async () => {
		const { source, cwdB, bundleDir, ledger, readIdentity } = await setup();
		await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		await finishMove({ sessionFile: source, bundleDir, moveId: MOVE, answer: { state: "accepted" } });
		const manager = SessionManager.open(source);
		expect(() => manager.appendCustomEntry(SESSION_RECLAIMED, { move_id: MOVE, session_id: SESSION_ID })).toThrow(
			SessionMovedAwayError,
		);
		expect(customTypes(source).at(-1)).toBe(SESSION_MOVED);
	});

	it("#given A to B and back to A #then A imports over its read-only copy and owns the session again", async () => {
		const { base, cwdA, source, cwdB, bundleDir, ledger, readIdentity } = await setup();
		const { sessionFile: onB } = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		await finishMove({ sessionFile: source, bundleDir, moveId: MOVE, answer: { state: "accepted" } });
		appendUserMessage(onB, "written on B");
		const backDir = join(base, "bundle-back");
		await exportSessionForMove({
			sessionFile: onB,
			moveId: BACK,
			target: "device-a",
			droppedUserMessages: [],
			bundleDir: backDir,
		});
		const ledgerA = new MoveLedger(join(base, "ledger-a"));
		await ledgerA.prepare(BACK);
		const { sessionFile } = await importMovedSession({
			bundleDir: backDir,
			targetCwd: cwdA,
			ledger: ledgerA,
			readIdentity,
		});
		expect(sessionFile).toBe(source);
		expect(readFileSync(sessionFile, "utf8")).toContain("written on B");
		expect(() => appendUserMessage(sessionFile, "back on A")).not.toThrow();
		expect(await answerMoveStatus(ledgerA, BACK, sessionFile)).toEqual({ state: "accepted" });
	});

	it("#given a writable session with the same id already at the target #then the import fails and the ledger says import_failed", async () => {
		const { cwdB, bundleDir, ledger, readIdentity, source } = await setup();
		const occupied = join(getDefaultSessionDir(cwdB), basename(source));
		mkdirSync(dirname(occupied), { recursive: true });
		writeFileSync(
			occupied,
			`${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "t", cwd: cwdB })}\n`,
		);
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toThrow();
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "failed", reason: "import_failed" });
	});

	it("#given a copy of a session that moved away #then the copy is writable", async () => {
		const { source, cwdA } = await setup();
		const fork = SessionManager.forkFrom(source, cwdA);
		expect(() => fork.appendMessage({ role: "user", content: "on the copy", timestamp: 4 })).not.toThrow();
	});

	it("#given a branch of a session that moved away #then the branch is writable and the original is not rewritten", async () => {
		const { source } = await setup();
		const before = readFileSync(source, "utf8");
		const manager = SessionManager.open(source);
		const leaf = manager.getEntries().find((entry) => entry.type === "message");
		if (leaf === undefined) throw new Error("fixture has no message");
		const branched = manager.createBranchedSession(leaf.id);
		expect(branched).toBeDefined();
		expect(() => manager.appendMessage({ role: "user", content: "on the branch", timestamp: 5 })).not.toThrow();
		expect(readFileSync(source, "utf8")).toBe(before);
	});

	it("#given an answer or bundle for a different move #then finishing refuses and changes nothing", async () => {
		const { source, bundleDir } = await setup();
		await expect(
			finishMove({
				sessionFile: source,
				bundleDir,
				moveId: BACK,
				answer: { state: "declined", reason: "no_record" },
			}),
		).rejects.toThrow(/move/);
		expect(customTypes(source).at(-1)).toBe(SESSION_RELEASED);
		expect(existsSync(bundleDir)).toBe(true);
	});

	it("#given a session that came back by import #then a leftover bundle of an older move is not re-queued into it", async () => {
		const { base, source, bundleDir } = await setup();
		const kept = join(base, "bundle-kept");
		cpSync(bundleDir, kept, { recursive: true });
		await finishMove({
			sessionFile: source,
			bundleDir,
			moveId: MOVE,
			answer: { state: "declined", reason: "no_record" },
		});
		SessionManager.open(source).appendCustomEntry(SESSION_RELEASED, { reason: "takeover" });
		await finishMove({ sessionFile: source, bundleDir: kept, moveId: BACK, answer: { state: "accepted" } }).catch(
			() => undefined,
		);
		expect(admittedInputs(source)).toEqual(["queued follow-up"]);
	});

	it("#given a reclaim that crashed after session_reclaimed but before the re-queue #then running it again queues the input once", async () => {
		const { source, bundleDir } = await setup();
		SessionManager.open(source).appendCustomEntry(SESSION_RECLAIMED, { move_id: MOVE, session_id: SESSION_ID });
		await finishMove({
			sessionFile: source,
			bundleDir,
			moveId: MOVE,
			answer: { state: "declined", reason: "no_record" },
		});
		expect(admittedInputs(source)).toEqual(["queued follow-up"]);
	});

	it("#given an import that crashed after staging session_moved_in but before the re-queue #then running it again queues the input once", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const sessionDir = getDefaultSessionDir(cwdB);
		const staged = join(sessionDir, ".move-staging", encodeURIComponent(MOVE), `x_${SESSION_ID}.jsonl`);
		const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")) as {
			sessionFileName: string;
		};
		const file = join(dirname(staged), manifest.sessionFileName);
		mkdirSync(dirname(file), { recursive: true });
		cpSync(join(bundleDir, "files", "session.jsonl"), file);
		SessionManager.open(file, dirname(file)).appendCustomEntry(SESSION_MOVED_IN, {
			move_id: MOVE,
			session_id: SESSION_ID,
		});
		const { sessionFile } = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		expect(admittedInputs(sessionFile)).toEqual(["queued follow-up"]);
	});

	it("#given a move the receiver was asked about before it arrived #then the late import is refused", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup(undefined, undefined, { ready: false });
		expect(await answerMoveStatus(ledger, MOVE, undefined)).toEqual({ state: "declined", reason: "no_record" });
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveFencedError,
		);
		expect(existsSync(join(getDefaultSessionDir(cwdB), ".move-staging"))).toBe(false);
	});

	it("#given a move already receiving #when it is cancelled or expires #then it keeps receiving", async () => {
		const { ledger } = await setup();
		await ledger.beginReceive(MOVE, LANDING);
		expect(await ledger.decline(MOVE, "expired")).toEqual({ state: "receiving" });
		expect(await ledger.fail(MOVE, "import_failed")).toEqual({ state: "failed", reason: "import_failed" });
	});
});
