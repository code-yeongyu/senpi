import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryReportSessionSource } from "../../../src/core/memory-report/memory-report-registry.ts";
import { memoryReportDir, writeMemoryReports } from "../../../src/core/memory-report/memory-report-write.ts";

// senpi#2561 review: two unsaved sessions in one process shared the pid-only fallback dir, so
// same-stamp reports overwrote each other. Each session now gets its own fallback directory.

const created: string[] = [];

afterEach(() => {
	for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function unsavedSource(sessionId: string): MemoryReportSessionSource {
	return {
		sessionId: () => sessionId,
		sessionFile: () => undefined,
		residentStore: () => ({ entries: 0, approxBytes: 0 }),
		reporters: () => [],
	};
}

function savedSource(sessionId: string, sessionFile: string): MemoryReportSessionSource {
	return { ...unsavedSource(sessionId), sessionFile: () => sessionFile };
}

function readReport(path: string): { sessionId: string } {
	return JSON.parse(readFileSync(path, "utf8")) as { sessionId: string };
}

describe("memory report write paths (#2561)", () => {
	it("Given two unsaved sessions in one process when reports are written then both survive at distinct paths", async () => {
		const [first, second] = await writeMemoryReports([unsavedSource("session-a"), unsavedSource("session-b")]);

		expect(first?.ok).toBe(true);
		expect(second?.ok).toBe(true);
		if (first?.ok !== true || second?.ok !== true) throw new Error("reports not written");
		expect(first.path).not.toBe(second.path);
		created.push(dirname(first.path), dirname(second.path));
		expect(readReport(first.path).sessionId).toBe("session-a");
		expect(readReport(second.path).sessionId).toBe("session-b");
	});

	it("Given a saved and an unsaved session when reports are written then each lands beside its own root", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-2561-collision-"));
		created.push(root);
		const sessionFile = join(root, "session.jsonl");
		writeFileSync(sessionFile, "");

		const [saved, unsaved] = await writeMemoryReports([savedSource("saved", sessionFile), unsavedSource("unsaved")]);

		expect(saved?.ok).toBe(true);
		if (saved?.ok !== true || unsaved?.ok !== true) throw new Error("reports not written");
		const artifacts = `${sessionFile.slice(0, -".jsonl".length)}-artifacts`;
		expect(dirname(saved.path)).toBe(join(artifacts, "memory"));
		created.push(artifacts, dirname(unsaved.path));
		expect(unsaved.path).toContain(`senpi-memory-report-${process.pid}-unsaved`);
	});

	it("Given one session whose report dir is blocked when reports are written then the other still gets its report", async () => {
		const blocker = memoryReportDir(undefined, "blocked");
		writeFileSync(blocker, "not a directory");
		created.push(blocker);

		const [blocked, fine] = await writeMemoryReports([unsavedSource("blocked"), unsavedSource("fine")]);

		expect(blocked).toMatchObject({ ok: false });
		expect(fine?.ok).toBe(true);
		if (fine?.ok !== true) throw new Error("surviving report not written");
		created.push(dirname(fine.path));
		expect(readReport(fine.path).sessionId).toBe("fine");
	});
});
