/**
 * A `move_fenced` refusal of an accepted move also says where the move landed, from a read of the move's record and
 * the landed file. These cases hold what happens when that read fails: a file-system error or a record lock that
 * stayed taken leaves the refusal as it is, anything else is answered `move_failed`, and either way the host writes
 * one line that names the kind and the move.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveRecordLockWaitError } from "../../src/core/session-move/move-ledger-lock.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, importedOnB, move } from "./rpc-move-session-support.ts";

const beforeLandedRead = vi.hoisted((): { run: (() => void) | undefined } => ({ run: undefined }));

// The read is one call from the refusal's handler. A test acts right before it: it throws what the read would, or
// changes the files the real read then meets.
vi.mock("../../src/core/session-move/import.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/session-move/import.ts")>();
	return {
		...actual,
		answerMoveStatusAndLanding: async (...args: Parameters<typeof actual.answerMoveStatusAndLanding>) => {
			beforeLandedRead.run?.();
			return actual.answerMoveStatusAndLanding(...args);
		},
	};
});

afterEach(() => {
	beforeLandedRead.run = undefined;
	vi.restoreAllMocks();
});

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);

function landedReadWarnings(): () => string[] {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return () => stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("landed_read"));
}

async function acceptedOnB(moveId: string) {
	const fixture = await devices();
	const a = createInProcessRig(fixture.agentA);
	const b = createInProcessRig(fixture.agentB);
	const landed = await importedOnB(a, b, fixture, moveId);
	const bundleDir = join(fixture.agentA, "session-moves", "outgoing", moveId);
	const importElsewhere = () => move(b, { op: "import", bundleDir, cwd: fixture.repoA, from: "device-a" });
	return { fixture, a, b, landed, importElsewhere };
}

describe("move_session: a failed read of where an accepted move landed (senpi#6436)", () => {
	it("#given a folder stands at the landed path, so reading it fails EISDIR #when the import into another folder is refused twice #then each refusal is move_fenced without the landed fields, each writes one line with the errno code and the move id, and the record's lock is free after each", async () => {
		const { fixture, a, b, landed, importElsewhere } = await acceptedOnB("move-k1");
		await using _a = a;
		await using _b = b;
		rmSync(landed);
		mkdirSync(landed);
		const warnings = landedReadWarnings();

		const first = await importElsewhere();
		const lockAfterFirst = existsSync(`${ledgerFile(fixture.agentB, "move-k1")}.lock`);
		const second = await importElsewhere();

		for (const refused of [first, second]) {
			expect(refused).toMatchObject({ success: false, error: "move_fenced" });
			expect(refused.errorData).toEqual({ detail: expect.any(String) });
		}
		// A lock left held by the failed read would make the second read wait it out and report `lock_wait`.
		expect(lockAfterFirst).toBe(false);
		expect(warnings()).toEqual([
			"senpi rpc move_landed_read_failed: kind=EISDIR move=move-k1\n",
			"senpi rpc move_landed_read_failed: kind=EISDIR move=move-k1\n",
		]);
	});

	it("#given the record's lock stays taken for the whole wait of that read #when the import into another folder is refused #then the refusal is move_fenced without the landed fields and the line says lock_wait", async () => {
		const { fixture, a, b, importElsewhere } = await acceptedOnB("move-k2");
		await using _a = a;
		await using _b = b;
		const warnings = landedReadWarnings();
		beforeLandedRead.run = () => {
			throw new MoveRecordLockWaitError(ledgerFile(fixture.agentB, "move-k2"), 15_000, new Error("ELOCKED"));
		};

		const refused = await importElsewhere();

		expect(refused).toMatchObject({ success: false, error: "move_fenced" });
		expect(refused.errorData).toEqual({ detail: expect.any(String) });
		expect(warnings()).toEqual(["senpi rpc move_landed_read_failed: kind=lock_wait move=move-k2\n"]);
	});

	it("#given the move's record no longer parses when that read reaches it #when the import into another folder is refused #then the caller is answered move_failed with that error's message, never move_fenced, and the line says unexpected", async () => {
		const { fixture, a, b, importElsewhere } = await acceptedOnB("move-k3");
		await using _a = a;
		await using _b = b;
		const warnings = landedReadWarnings();
		const record = ledgerFile(fixture.agentB, "move-k3");
		beforeLandedRead.run = () => writeFileSync(record, "{}\n");

		const refused = await importElsewhere();

		expect(refused).toMatchObject({ success: false, error: "move_failed" });
		expect(refused.errorData).toEqual({ detail: `Move record ${record} is not a move record` });
		expect(warnings()).toEqual(["senpi rpc move_landed_read_failed: kind=unexpected move=move-k3\n"]);
	});

	it("#given that read throws an error that is no file-system error #when the import into another folder is refused #then the caller is answered move_failed with that error's message and the line says unexpected, with none of the message in it", async () => {
		const { a, b, importElsewhere } = await acceptedOnB("move-k4");
		await using _a = a;
		await using _b = b;
		const warnings = landedReadWarnings();
		beforeLandedRead.run = () => {
			throw new TypeError("landed is not a function");
		};

		const refused = await importElsewhere();

		expect(refused).toMatchObject({ success: false, error: "move_failed" });
		expect(refused.errorData).toEqual({ detail: "landed is not a function" });
		expect(warnings()).toEqual(["senpi rpc move_landed_read_failed: kind=unexpected move=move-k4\n"]);
	});
});
