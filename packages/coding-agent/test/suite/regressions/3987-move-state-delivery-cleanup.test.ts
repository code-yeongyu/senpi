/**
 * senpi#3987 items 2 and 3: a delivery copy a late import handler recreated after the state was restored is removed
 * on the session's next open (that session's copies only), and a copy that failed leaves no `delivered` marker, so
 * the next delivery is not reported as a redelivery of state no handler saw.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { restoreMovedState } from "../../../src/core/session-move/extension-state.ts";
import { moveIn } from "../session-move-extension-state-support.ts";
import { root, writeSession } from "../session-move-fixture.ts";

const deliveryRoot = (sessionFile: string): string => join(dirname(sessionFile), ".move-state", "delivery");

describe("move extension-state delivery cleanup (senpi#3987)", () => {
	it("removes this session's late-recreated delivery copy on its next open, and leaves another session's alone", async () => {
		const sessionFile = writeSession(join(root(), "repo"));
		moveIn(sessionFile, "move-93");
		await restoreMovedState(SessionManager.open(sessionFile), async () => true);
		const own = join(deliveryRoot(sessionFile), `${basename(sessionFile, ".jsonl")}.move-93`, "attempt-late");
		const other = join(deliveryRoot(sessionFile), "another-session.move-93", "attempt-late");
		mkdirSync(own, { recursive: true });
		mkdirSync(other, { recursive: true });

		await restoreMovedState(SessionManager.open(sessionFile), async () => {
			throw new Error("nothing is pending, so no handler runs");
		});

		expect(existsSync(dirname(own))).toBe(false);
		expect(existsSync(other)).toBe(true);
	});

	it("writes no delivered marker when the copy fails, so the next delivery is not a redelivery", async () => {
		const sessionFile = writeSession(join(root(), "repo"));
		const pending = moveIn(sessionFile, "move-94");
		const probe = join(pending, "probe");
		chmodSync(probe, 0o000);
		try {
			await expect(restoreMovedState(SessionManager.open(sessionFile), async () => true)).rejects.toThrow();
		} finally {
			chmodSync(probe, 0o755);
		}
		const bookkeeping = join(deliveryRoot(sessionFile), basename(pending));
		expect(existsSync(bookkeeping) ? readdirSync(bookkeeping) : []).toEqual([]);

		const seen: boolean[] = [];
		await restoreMovedState(SessionManager.open(sessionFile), async (event) => {
			seen.push(event.redelivered);
			return true;
		});
		expect(seen).toEqual([false]);
	});
});
