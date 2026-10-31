import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#3864 review (#3963): lifecycle bookkeeping written before any conversation must not keep an
// empty session's file alive, the same rule as startup bookkeeping (senpi#3263).
let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

it.each(["session-lifecycle", "work-custody", "child-lifecycle"])(
	"discards a file that only %s records created",
	async (customType) => {
		// Given a new session whose first write is lifecycle bookkeeping.
		dir = mkdtempSync(join(tmpdir(), "senpi-3864-discard-"));
		const manager = SessionManager.create(dir, dir);
		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		manager.appendCustomEntry(customType, { seq: 1 });
		expect(existsSync(file)).toBe(true);

		// When the session closes without a conversation.
		const discarded = await manager.discardHeaderOnlyFile();

		// Then no empty session is left behind.
		expect(discarded).toBe(true);
		expect(existsSync(file)).toBe(false);
	},
);

it("keeps a lifecycle-created file once the session has a user message", async () => {
	// Given lifecycle bookkeeping followed by a person's prompt.
	dir = mkdtempSync(join(tmpdir(), "senpi-3864-discard-"));
	const manager = SessionManager.create(dir, dir);
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("no session file");
	manager.appendCustomEntry("session-lifecycle", { seq: 1 });
	manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });

	// When the session closes.
	const discarded = await manager.discardHeaderOnlyFile();

	// Then the conversation's file stays.
	expect(discarded).toBe(false);
	expect(existsSync(file)).toBe(true);
});
