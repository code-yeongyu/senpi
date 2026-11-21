import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { parseMoveId } from "../../src/core/session-move/bundle.ts";
import { stampFields, type UptimeStamp } from "../../src/core/session-move/move-landing.ts";
import { MoveRecordLocks } from "../../src/core/session-move/move-ledger-lock.ts";
import { MoveRecordFile } from "../../src/core/session-move/move-record-file.ts";

const LANDING = "/sessions/landing.jsonl";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the stamp a move record's write carries beside its time", () => {
	it("#given the stamp's type #then it names only up and host, so no key of a stamp can be a custody field", () => {
		// Checked by the typecheck: a key added to the stamp, or a stamp typed as any record again, does not compile.
		expectTypeOf<keyof UptimeStamp>().toEqualTypeOf<"up" | "host">();
		expectTypeOf(stampFields).returns.toEqualTypeOf<UptimeStamp>();
	});

	it("#given a stamp that also carries committing, state, target and at #then the write keeps the record's own custody fields and its own time", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-stamp-")));
		dirs.push(dir);
		const locks = new MoveRecordLocks();
		// Structural typing lets an object with more keys through a function typed to return the stamp; the order of
		// the write's spread is what keeps such keys from replacing the record's.
		const wider = {
			up: 7,
			host: "this-host",
			committing: true,
			state: "failed",
			target: "/sessions/elsewhere.jsonl",
			at: "1970-01-01T00:00:00.000Z",
		};
		const file = new MoveRecordFile(dir, locks, () => wider);
		const moveId = parseMoveId("move-stamp");

		const at = await locks.hold(file.path(moveId), () =>
			file.write(moveId, { state: "receiving" }, { target: LANDING }),
		);

		const written: unknown = JSON.parse(readFileSync(file.path(moveId), "utf8"));
		expect(written).toEqual({ state: "receiving", target: LANDING, at, up: 7, host: "this-host" });
		expect(at).not.toBe(wider.at);
	});
});
