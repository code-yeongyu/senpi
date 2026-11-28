import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { processBootAtMs } from "../../../src/core/extensions/builtin/terminal/process-identity.ts";
import { holdSessionFile, SessionMovingError, withSessionMoveLock } from "../../../src/core/session-holders.ts";
import { encodedSessionId } from "../../../src/core/session-sidecar-store.ts";

// senpi#3979: the session move lock is the mover's while the mover lives, however long its move runs. Staleness means
// the mover is gone (its pid, boot and start identity), never that its move is slow. Past the 30 s that once made a
// lock stale, a live move keeps out both an opener (`holdSessionFile`) and a second mover (`withSessionMoveLock`).
let root: string;
let file: string;
let id: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "3979-move-lock-"));
	id = randomUUID();
	file = join(root, "session.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});

afterEach(async () => {
	vi.useRealTimers();
	await rm(root, { recursive: true, force: true });
});

async function pastTheOldStaleWindowInsideAMove(): Promise<{ opener: unknown; mover: unknown }> {
	vi.useFakeTimers({ toFake: ["Date"] });
	return withSessionMoveLock(
		file,
		id,
		async () => {
			vi.setSystemTime(Date.now() + 31_000);
			const opener = await holdSessionFile(file, id, { expectExisting: true }).then(
				(hold) => {
					hold.release();
					return "admitted";
				},
				(error: unknown) => error,
			);
			const mover = await withSessionMoveLock(file, id, () => "moved", { waitMs: 0 }).catch(
				(error: unknown) => error,
			);
			return { opener, mover };
		},
		{ waitMs: 0 },
	);
}

it("an opener is refused while a move that outlived 30 s is still running", async () => {
	const { opener } = await pastTheOldStaleWindowInsideAMove();
	expect(opener).toBeInstanceOf(SessionMovingError);
});

it("a second mover is refused while a move that outlived 30 s is still running", async () => {
	const { mover } = await pastTheOldStaleWindowInsideAMove();
	expect(mover).toBeInstanceOf(SessionMovingError);
});

it("a lock left by a mover that died lets both an opener and the next mover in", async () => {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await once(child, "exit");
	const dir = join(root, "session-holders", encodedSessionId(id));
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "move.lock"),
		JSON.stringify({ pid: child.pid, bootAtMs: await processBootAtMs(), processStartedAtMs: 1 }),
	);

	const hold = await holdSessionFile(file, id, { expectExisting: true });
	hold.release();
	expect(await withSessionMoveLock(file, id, () => "moved", { waitMs: 0 })).toBe("moved");
});
