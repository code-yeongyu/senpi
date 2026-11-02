import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";
import { importMovedSession, MoveRefusedError } from "../../src/core/session-move/import.ts";
import {
	SESSION_MOVED,
	SESSION_MOVED_IN,
	SESSION_RECLAIMED,
	SessionMovedAwayError,
} from "../../src/core/session-move/ownership.ts";
import {
	admittedInputs,
	appendUserMessage,
	customTypes,
	MOVE,
	OTHER,
	SESSION_ID,
	setup,
} from "./session-move-fixture.ts";

describe("session move between two folders", () => {
	it("#given an exported session #then A is read-only and the bundle carries the file, sidecars and dropped input", async () => {
		const { source, bundleDir } = await setup();
		expect(() => appendUserMessage(source, "after export")).toThrow(SessionMovedAwayError);
		expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
	});

	it("#given a same-repository import #then B owns the session under the same id, with sidecars and the queued input", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const { sessionFile } = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

		expect(dirname(sessionFile)).toBe(getDefaultSessionDir(cwdB));
		expect(basename(sessionFile)).toContain(SESSION_ID);
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0] ?? "") as { cwd: string; id: string };
		expect(header).toMatchObject({ id: SESSION_ID, cwd: cwdB });
		expect(customTypes(sessionFile).at(-1)).toBe(SESSION_MOVED_IN);
		expect(admittedInputs(sessionFile)).toEqual(["queued follow-up"]);
		expect(existsSync(join(dirname(sessionFile), "extensions", "goal", `${SESSION_ID}.json`))).toBe(true);
		expect(() => appendUserMessage(sessionFile, "on B")).not.toThrow();
		expect(await ledger.answerStatus(MOVE, { movedIn: true })).toEqual({ state: "accepted" });
	});

	it("#given the same bundle imported twice #then the second import changes nothing", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const first = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		const before = readFileSync(first.sessionFile, "utf8");
		const second = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		expect(second.sessionFile).toBe(first.sessionFile);
		expect(readFileSync(second.sessionFile, "utf8")).toBe(before);
	});

	it("#given an import that crashed after its rename but before the ledger recorded it #when it runs again #then the move is recorded accepted", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		rmSync(ledger.dir, { recursive: true, force: true });
		await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given a different repository at B #then the import is refused with a reason and nothing lands at B", async () => {
		const { cwdB, source, bundleDir, ledger, readIdentity } = await setup(OTHER);
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toMatchObject({
			code: "move_repository_mismatch",
		});
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveRefusedError,
		);
		expect(existsSync(join(getDefaultSessionDir(cwdB), basename(source)))).toBe(false);
	});

	it("#given a tampered bundle #then the import fails and B records failed", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const file = join(bundleDir, "files", "session.jsonl");
		writeFileSync(file, `${readFileSync(file, "utf8")}{"tampered":true}\n`);
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toMatchObject({
			code: "move_bundle_invalid",
		});
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({
			state: "failed",
			reason: "bundle_invalid",
		});
	});

	it("#given B accepted #when A finishes #then A records session_moved and stays read-only", async () => {
		const { source, cwdB, bundleDir, ledger, readIdentity } = await setup();
		await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		await finishMove({ sessionFile: source, bundleDir, moveId: MOVE, answer: { state: "accepted" } });
		expect(customTypes(source).at(-1)).toBe(SESSION_MOVED);
		expect(() => appendUserMessage(source, "still here")).toThrow(SessionMovedAwayError);
		expect(existsSync(bundleDir)).toBe(false);
	});

	it("#given B declined #when A finishes #then A reclaims, its queued input is back, and A may write again", async () => {
		const { source, bundleDir } = await setup();
		await finishMove({
			sessionFile: source,
			bundleDir,
			moveId: MOVE,
			answer: { state: "declined", reason: "no_record" },
		});
		expect(customTypes(source).at(-1)).toBe(SESSION_RECLAIMED);
		expect(admittedInputs(source)).toEqual(["queued follow-up"]);
		expect(() => appendUserMessage(source, "back on A")).not.toThrow();
		expect(existsSync(bundleDir)).toBe(false);
	});

	it("#given a reclaim that crashed before deleting its bundle #when it runs again #then the input is queued once", async () => {
		const { base, source, bundleDir } = await setup();
		const answer = { state: "declined", reason: "no_record" } as const;
		const kept = join(base, "bundle-kept");
		cpSync(bundleDir, kept, { recursive: true });
		await finishMove({ sessionFile: source, bundleDir, moveId: MOVE, answer });
		cpSync(kept, bundleDir, { recursive: true });
		await finishMove({ sessionFile: source, bundleDir, moveId: MOVE, answer });
		expect(admittedInputs(source)).toEqual(["queued follow-up"]);
	});
});
