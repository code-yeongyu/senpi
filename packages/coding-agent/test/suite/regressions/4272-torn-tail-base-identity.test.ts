import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Part of #4272, carry item 18: the full-load preload of a legacy file with an oversized header must describe the
// file as the open's torn-tail repair left it, so the persisted base and every later append read back exactly.
for (const tail of ["torn", "unterminated"] as const) {
	it(`item 18 an oversized-header file with a ${tail} final line keeps a readable persisted base`, async () => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const dir = await mkdtemp(join(tmpdir(), "senpi-4272-torn-base-"));
		dirs.push(dir);
		const writer = SessionManager.create(dir, dir);
		writer.appendMessage({ role: "user", content: "kept", timestamp: 1 });
		await writer.persistHeaderNow();
		const file = String(writer.getSessionFile());
		writer.dispose();
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		lines[0] = JSON.stringify({ ...JSON.parse(lines[0] ?? "{}"), padding: "x".repeat(1_100_000) });
		writeFileSync(file, `${lines.join("\n")}\n`);
		const last = JSON.stringify({
			type: "custom",
			customType: "note",
			id: "unterminated-entry",
			parentId: JSON.parse(lines[1] ?? "{}").id,
			timestamp: new Date(2).toISOString(),
		});
		appendFileSync(file, tail === "torn" ? last.slice(0, 20) : last);

		const manager = SessionManager.open(file);
		try {
			expect(readFileSync(file, "utf8").endsWith("\n"), "the open repaired the final line").toBe(true);
			const lane = new SessionAcceptanceLane();
			lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
			await manager["transcriptFile"].ready;
			lane.applyTranscript(manager.drainTranscript());
			const opened = readTranscriptRoot(lane.freeze().transcript);
			expect(opened.ok, JSON.stringify(opened)).toBe(true);
			const ids = (opened.ok ? opened.entries : []).map((entry) => entry.id);
			expect(ids.includes("unterminated-entry")).toBe(tail === "unterminated");
			manager.appendMessage({ role: "user", content: "after repair", timestamp: 3 });
			await manager.persistHeaderNow();
			lane.applyTranscript(manager.drainTranscript());
			const appended = readTranscriptRoot(lane.freeze().transcript);
			expect(appended.ok, JSON.stringify(appended)).toBe(true);
			expect(appended.ok && appended.entries.at(-1)).toMatchObject({ message: { content: "after repair" } });
		} finally {
			manager.dispose();
		}
	});
}
