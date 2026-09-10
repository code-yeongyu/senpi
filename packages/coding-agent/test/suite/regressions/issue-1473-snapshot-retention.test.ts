import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionResumeConflictError } from "../../../src/core/session-resume-conflict.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(text: string) {
	const cwd = mkdtempSync(join(tmpdir(), "pr1473-snapshot-"));
	roots.push(cwd);
	const path = join(cwd, "target.jsonl");
	const bytes = [
		JSON.stringify({ type: "session", version: 3, id: "target", timestamp: new Date(0).toISOString(), cwd }),
		JSON.stringify({
			type: "message",
			id: "message",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: text, timestamp: 0 },
		}),
		"",
	].join("\n");
	writeFileSync(path, bytes);
	return { path, bytes };
}

// PR #1473 g6BJr: conflict metadata must not retain a second transcript-sized representation.
it("keeps prepared snapshot metadata bounded when the transcript is large", () => {
	// Given a real transcript substantially larger than the snapshot metadata budget.
	const { path, bytes } = fixture("payload ".repeat(256 * 1024));

	// When the actual manager stages that transcript without accepting it.
	const prepared = SessionManager.prepareOpen(path);
	const snapshots = prepared.sessionManager["deferredPersistence"]?.snapshots;

	// Then retained conflict metadata is bounded independently of transcript content.
	expect(snapshots).toBeDefined();
	expect(serialize(snapshots).byteLength).toBeLessThan(4096);
	expect(readFileSync(path, "utf8")).toBe(bytes);
});

// PR #1473: bounded fingerprints must retain byte-level, not just stat-level, conflict detection.
it("rejects same-size changed content even when the original modification time is restored", () => {
	// Given an accepted writer grant for a staged file.
	const { path, bytes } = fixture("before");
	const original = statSync(path);
	const prepared = SessionManager.prepareOpen(path);
	const acceptance = prepared.beginCommit();
	const changed = bytes.replace('"content":"before"', '"content":"after!"');
	expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(bytes));

	// When an external writer changes content without changing length or final mtime.
	writeFileSync(path, changed);
	utimesSync(path, original.atime, original.mtime);

	// Then commit rejects and preserves the external bytes.
	expect(() => acceptance.commit()).toThrow(SessionResumeConflictError);
	expect(readFileSync(path, "utf8")).toBe(changed);
});

// PR #1473: metadata-only changes are not content conflicts.
it("accepts identical content after only file timestamps change", () => {
	// Given a staged, unchanged transcript.
	const { path, bytes } = fixture("unchanged");
	const prepared = SessionManager.prepareOpen(path);

	// When only timestamps change before acceptance.
	utimesSync(path, new Date(0), new Date(1000));
	prepared.beginCommit().commit();

	// Then acceptance preserves the complete original bytes.
	expect(readFileSync(path, "utf8")).toBe(bytes);
});
