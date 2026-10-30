// Regression for sisyphuslabs/omo-desktop-app#3137 (desktop#4008 handover): a re-run import after a lost `accepted` write.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerMoveStatus, importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveFencedError, MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { customTypes, MOVE, setup } from "./session-move-fixture.ts";

class LosesAcceptedWrite extends MoveLedger {
	landed: string | undefined;
	private readonly renames: boolean;

	constructor(dir: string, renames: boolean) {
		super(dir);
		this.renames = renames;
	}

	override commit<T>(moveId: MoveId, target: string, rename: () => T | Promise<T>, prepare?: () => void): Promise<T> {
		return super.commit(
			moveId,
			target,
			async () => {
				if (this.renames) this.landed = String(await rename());
				throw new Error("the accepted write failed");
			},
			prepare,
		);
	}
}

describe("a re-run move import with the session file as the authority", () => {
	it("#given the accepted write failed after the rename #then the move stays receiving, and a re-run returns the session and records accepted", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const lossy = new LosesAcceptedWrite(ledger.dir, true);
		const lost = importMovedSession({ bundleDir, targetCwd: cwdB, ledger: lossy, readIdentity });
		await expect(lost).rejects.toThrow("the accepted write failed");
		const landed = lossy.landed ?? "";
		expect(customTypes(landed).at(-1)).toBe("session_moved_in");
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "receiving" });

		const again = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

		expect(again.sessionFile).toBe(landed);
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given the import failed before its rename #when it runs again #then the failed move is not accepted", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const lossy = new LosesAcceptedWrite(ledger.dir, false);
		const lost = importMovedSession({ bundleDir, targetCwd: cwdB, ledger: lossy, readIdentity });
		await expect(lost).rejects.toThrow("the accepted write failed");
		expect(lossy.landed).toBeUndefined();

		const again = importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		await expect(again).rejects.toBeInstanceOf(MoveFencedError);
		expect(await answerMoveStatus(ledger, MOVE, undefined)).toEqual({
			state: "failed",
			reason: "import_failed",
		});
	});

	it("#given a ready, declined or failed move #when confirmLanded runs #then it is refused and the record stays", async () => {
		const { base, ledger } = await setup();
		const target = join(base, "landed.jsonl");
		await expect(ledger.confirmLanded(MOVE, target, false)).rejects.toBeInstanceOf(MoveFencedError);
		const declined = "move-0002" as MoveId;
		await ledger.decline(declined, "cancelled");
		await expect(ledger.confirmLanded(declined, target, false)).rejects.toBeInstanceOf(MoveFencedError);
		expect(await ledger.answerStatus(declined, { movedIn: false })).toEqual({
			state: "declined",
			reason: "cancelled",
		});
		const failed = "move-0003" as MoveId;
		await ledger.fail(failed, "import_failed");
		await expect(ledger.confirmLanded(failed, target, false)).rejects.toBeInstanceOf(MoveFencedError);
		expect(await ledger.answerStatus(failed, { movedIn: false })).toEqual({
			state: "failed",
			reason: "import_failed",
		});
	});
});
