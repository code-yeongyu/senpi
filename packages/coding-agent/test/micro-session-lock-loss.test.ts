import { readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlStorage } from "../../agent/src/harness/pico3/index.ts";
import { FileLockLostError } from "../src/core/file-lock.ts";
import { lockGatedStorage } from "../src/experimental/micro/lock-gated-storage.ts";
import { selectSession } from "../src/experimental/micro/sessions.ts";

const realLock = lockfile.lock;
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const close of closers.splice(0)) await close();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function sessionBytes(path: string): number {
	return readdirSync(path).reduce((total, file) => total + statSync(join(path, file)).size, 0);
}

describe("micro session lock loss", () => {
	it("RED: once another process reclaims the session lock, the session gets no further writes", async () => {
		let compromise: ((error: Error) => void) | undefined;
		vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			compromise = options?.onCompromised;
			return realLock(file, options);
		});
		const cwd = await mkdtemp(join(tmpdir(), "micro-lock-loss-"));
		dirs.push(cwd);
		const onLost = vi.fn();
		const location = await selectSession(cwd, false, onLost);
		closers.push(() => location.release());
		const storage = await JsonlStorage.open(location.path);
		closers.push(() => storage.close(BACKGROUND_CONTEXT));
		const gated = lockGatedStorage(storage, location.assertHeld);

		await gated.commit([], BACKGROUND_CONTEXT);
		const written = sessionBytes(location.path);
		expect(written).toBeGreaterThan(0);

		compromise?.(Object.assign(new Error("lock reclaimed"), { code: "ECOMPROMISED" }));

		expect(onLost).toHaveBeenCalledTimes(1);
		await expect(gated.commit([], BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(FileLockLostError);
		await expect(gated.truncate({ conversationId: 1, doc: "sticky" }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			FileLockLostError,
		);
		expect(sessionBytes(location.path)).toBe(written);
		expect(await gated.conversations(BACKGROUND_CONTEXT)).toEqual(await storage.conversations(BACKGROUND_CONTEXT));
	});
});
