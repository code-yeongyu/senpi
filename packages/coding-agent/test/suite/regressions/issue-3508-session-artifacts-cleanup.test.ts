import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionArtifactsDir } from "../../../../senpi-codemode/src/output/output-meta.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { deleteSessionFile } from "../../../src/modes/interactive/components/session-selector.ts";

// senpi#3508: senpi-codemode keeps eval logs in <session>-artifacts/ beside the session file. Removing
// the session through either path must remove that directory too, so deleted eval output is gone.

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function evalLogFor(sessionFile: string): string {
	const artifacts = resolveSessionArtifactsDir(sessionFile);
	const log = join(artifacts.dir, "eval-1.log");
	writeFileSync(log, "kernel output\n");
	return artifacts.dir;
}

describe("removing a session removes its codemode artifacts (#3508)", () => {
	it("deleting a session from the selector removes its -artifacts directory", async () => {
		dir = mkdtempSync(join(tmpdir(), "senpi-3508-"));
		const sessionFile = join(dir, "2026-11-02T00-00-00-000Z_0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0002" })}\n`,
		);
		const artifacts = evalLogFor(sessionFile);

		const result = await deleteSessionFile(sessionFile);

		expect(result.ok).toBe(true);
		expect(result.artifactsError).toBeUndefined();
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(artifacts)).toBe(false);
	});

	it("discarding a conversation-free session removes its -artifacts directory", async () => {
		dir = mkdtempSync(join(tmpdir(), "senpi-3508-"));
		const manager = SessionManager.create(dir, dir);
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) throw new Error("no session file");
		await manager.persistHeaderNow();
		const artifacts = evalLogFor(sessionFile);

		expect(await manager.discardHeaderOnlyFile()).toBe(true);
		expect(existsSync(artifacts)).toBe(false);
	});

	it("a kept session keeps its -artifacts directory", async () => {
		dir = mkdtempSync(join(tmpdir(), "senpi-3508-"));
		const manager = SessionManager.create(dir, dir);
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) throw new Error("no session file");
		await manager.persistHeaderNow();
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		const artifacts = evalLogFor(sessionFile);

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(artifacts)).toBe(true);
	});
});
