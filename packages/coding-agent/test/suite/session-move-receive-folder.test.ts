/**
 * senpi#6435: a move that is already receiving is received again only for the folder it was received for. The
 * landing file does not tell two folders apart: a session folder is named from the working folder's path with `/`
 * turned into `-`, so `/work/a/b` and `/work/a-b` share one, and only one of them had its repository checked.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { MoveFencedError, MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

const MOVE = "receive-1" as MoveId;
const RECEIVED_FOR = "/work/a/b";
const SAME_SESSION_FOLDER = "/work/a-b";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-receive-")));
	dirs.push(dir);
	return dir;
}

describe("a receiving move is received again only for its own folder (senpi#6435)", () => {
	it("#given two folders that share one session folder and a move receiving for the first #when a receive for the second names the same landing file, and then a receive for the first does #then the second is refused, the first is let in, and the record still holds the first folder", async () => {
		const agentDir = temp();
		const landing = join(getDefaultSessionDir(RECEIVED_FOR, agentDir), "moved.jsonl");
		expect(join(getDefaultSessionDir(SAME_SESSION_FOLDER, agentDir), "moved.jsonl")).toBe(landing);
		const ledgerDir = temp();
		const book = new MoveLedger(ledgerDir);
		await book.prepare(MOVE);
		await book.beginReceive(MOVE, landing, { cwd: RECEIVED_FOR });

		await expect(book.beginReceive(MOVE, landing, { cwd: SAME_SESSION_FOLDER })).rejects.toBeInstanceOf(
			MoveFencedError,
		);
		await expect(book.beginReceive(MOVE, landing, { cwd: RECEIVED_FOR })).resolves.toBeUndefined();

		const stored = JSON.parse(readFileSync(join(ledgerDir, `${MOVE}.json`), "utf8")) as Record<string, unknown>;
		expect(stored).toMatchObject({ state: "receiving", target: landing, cwd: RECEIVED_FOR });
	});
});

// The import resolves its folder before it asks the ledger, so these two calls never see another spelling through
// the RPC. The ledger normalises anyway: it is the one place a move's folder is compared.
describe("the ledger compares a move's folder in one spelling (senpi#6435)", () => {
	it.each([
		["a trailing slash", "/work/one/"],
		["a . segment", "/work/./one"],
		["a .. segment", "/work/two/../one"],
		["a doubled slash", "/work//one"],
	])(
		"#given a move readied for a folder #when the import's fence and its receive name that folder with %s #then both let it in",
		async (_spelling, other) => {
			const book = new MoveLedger(temp());
			await book.prepare(MOVE, "/work/one");

			await expect(book.requireReadiedFor(MOVE, other)).resolves.toBeUndefined();
			await expect(book.beginReceive(MOVE, "/sessions/landing.jsonl", { cwd: other })).resolves.toBeUndefined();
		},
	);
});
