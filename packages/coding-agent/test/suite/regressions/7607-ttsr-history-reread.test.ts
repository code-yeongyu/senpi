import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../../src/core/session-manager.ts";
import { writeCompactedTranscript } from "../../benchmarks/3519-compacted-transcript.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7607: a reloaded TTSR extension rebuilt its state from getEntries(), so the first turn after a reload parsed
// a compacted session's whole file. The MCP and tool-search builtins are left out: their read is senpi#7600's.
it("reads none of a compacted session's history on the first turn after an extension reload", async () => {
	const dir = mkdtempSync(join(tmpdir(), "senpi-7607-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["mcp", "tool-search"] }));
	let harness: Harness | undefined;
	const readers: string[] = [];
	let counting = false;
	const restore = setSessionEntryLoaderForTesting((...args) => {
		if (counting) readers.push((new Error().stack ?? "").split("\n").slice(2, 9).join("\n"));
		return loadEntriesFromFile(...args);
	});
	try {
		const manager = SessionManager.open(writeCompactedTranscript(dir, 1), dir, dir);
		const resources = new DefaultResourceLoader({ cwd: dir, agentDir: dir });
		await resources.reload();
		harness = await createHarness({
			cwd: dir,
			sessionManager: manager,
			resourceLoader: resources,
			settings: { compaction: { enabled: false } },
		});
		await harness.session.bindExtensions({ mode: "rpc" });
		const active = harness;
		const turn = async () => {
			active.setResponses([fauxAssistantMessage("Complete.")]);
			await active.session.prompt("Answer briefly.");
			await active.session.waitForIdle();
			expect(active.getPendingResponseCount()).toBe(0);
		};
		await turn();
		active.session.releaseSettledSessionMemory();
		const reloaded = await active.session.reload();
		expect(reloaded.cancelled).toBe(false);

		counting = true;
		await turn();
		expect(readers).toEqual([]);
	} finally {
		restore();
		harness?.cleanup();
		await harness?.session.whenToolChildClosed();
		rmSync(dir, { recursive: true, force: true });
	}
});
