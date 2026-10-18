import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

describe("#3519 JSONL export of a compacted session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("exports the history before the compaction, live and after a reopen", async () => {
		// given a persisted session whose first turn a compaction left out of its window
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first request");
		await harness.session.prompt("second request");
		const kept = harness.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		if (kept === undefined) throw new Error("missing kept entry");
		harness.sessionManager.appendCompaction("summary", kept.id, 100);
		const exportedTexts = (path: string) =>
			readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.flatMap((entry) => (entry.type === "message" ? [getMessageText(entry.message)] : []));

		// when it is exported live, and again from a reopened manager
		const live = harness.session.exportToJsonl(join(harness.tempDir, "live.jsonl"));
		const sessionFile = harness.sessionManager.getSessionFile();
		if (sessionFile === undefined) throw new Error("missing session file");
		const reopened = SessionManager.open(sessionFile, join(harness.tempDir, "sessions"));
		harness.session.sessionManager.setSessionFile(sessionFile);

		// then both exports start with the first turn
		expect(exportedTexts(live).slice(0, 2)).toEqual(["first request", "first answer"]);
		expect(reopened.getFullBranch().length).toBeGreaterThan(reopened.getBranch().length);
		const afterReopen = harness.session.exportToJsonl(join(harness.tempDir, "reopened.jsonl"));
		expect(exportedTexts(afterReopen).slice(0, 2)).toEqual(["first request", "first answer"]);
	});
});
