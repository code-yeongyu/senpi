/**
 * senpi#6427: the folder an `open_session` works in is decided from the session file's header, and the file is found
 * through the moved-path probe. When that probe times out (a stalled mount), the old spelling of a moved file reads as
 * absent; falling back to the host's folder would open the session there, the defect #6427 closed. It refuses instead.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/extensions/builtin/moved-path-guard/resolve-async.ts", () => ({
	createMovedPathProbe: () => ({
		timedOut: true,
		stopped: false,
		stop: () => {},
		cleared: () => false,
		resolve: async () => undefined,
	}),
}));

const { openSessionFolder } = await import("../../src/modes/rpc/open-session-folder.ts");

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the folder an open_session works in, when the moved-path probe times out (senpi#6427)", () => {
	it("#given a session file and a probe that timed out #when the folder is decided #then it refuses instead of answering the host's folder", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "senpi-open-folder-"));
		dirs.push(scratch);
		const recorded = join(scratch, "project");
		const file = join(scratch, "session.jsonl");
		mkdirSync(recorded);
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "0199f0d4-6427-7000-8000-000000000099", timestamp: "2026-11-11T00:00:00.000Z", cwd: recorded })}\n`,
		);

		await expect(openSessionFolder({ sessionPath: file }, join(scratch, "host"))).rejects.toThrow(
			/could not be resolved/i,
		);
	});
});
