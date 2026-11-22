/**
 * senpi#6417: a commit's check of its record reads one version of it. A holder that lost its lock without knowing can
 * have the record replaced under it. A check that read the record and then its landing could pair one version's state
 * with the other's landing, and refuse the commit for a reason neither version gives.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveFencedError, MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

/** While `path` is set, `write` runs right after the next read of that file: what a holder that took the lock over does. */
const swap: { path?: string; write?: () => void } = {};

vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...real,
		readFile: async (...args: Parameters<typeof real.readFile>) => {
			const read = await real.readFile(...args);
			if (args[0] === swap.path) {
				swap.path = undefined;
				swap.write?.();
			}
			return read;
		},
	};
});

const MOVE = "swap-1" as MoveId;
const LANDING = "/sessions/landing.jsonl";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a commit checks one version of its record (senpi#6417)", () => {
	it("#given a receiving move whose record another holder settled failed right after the commit's first read of it #then the refusal carries the record that is on disk, and nothing is renamed", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-swap-")));
		dirs.push(dir);
		const file = join(dir, `${MOVE}.json`);
		const book = new MoveLedger(dir);
		await book.prepare(MOVE);
		await book.beginReceive(MOVE, LANDING);
		const failed = { state: "failed", reason: "import_failed" };
		swap.path = file;
		swap.write = () => writeFileSync(file, `${JSON.stringify({ ...failed, at: new Date(0).toISOString() })}\n`);
		let renamed = false;
		const rename = () => {
			renamed = true;
		};

		const refusal = await book.commit(MOVE, LANDING, rename).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(refusal).toBeInstanceOf(MoveFencedError);
		expect(refusal).toMatchObject({ record: failed });
		expect(renamed).toBe(false);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject(failed);
	});
});
