import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("#3519 full history on an idle rpc session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function idleTrimmedSession() {
		const harness = await createHarness({ persistSession: true, settings: { compaction: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
		await harness.session.prompt("first request");
		await harness.session.prompt("second request");
		const firstKept = harness.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "message" && entry.message.role === "user");
		if (firstKept === undefined) throw new Error("missing kept entry");
		harness.sessionManager.appendCompaction("summary", firstKept.id, 100);
		const runtime = new AgentSessionRuntime(
			harness.session,
			{
				cwd: harness.tempDir,
				agentDir: harness.session.agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.modelRegistry,
				modelRuntime: harness.session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("This fixture does not replace sessions");
			},
		);
		const records: Record<string, unknown>[] = [];
		const connect = () =>
			createRpcConnectionHandler(runtime, {
				writeRaw(chunk) {
					for (const line of chunk.split("\n").filter(Boolean)) records.push(JSON.parse(line));
				},
				waitForBackpressure: async () => {},
			});
		return { harness, records, connect };
	}

	it("answers get_entries and get_tree with the full history without keeping it resident", async () => {
		// given an idle persisted session whose mirror a compaction trimmed
		const { harness, records, connect } = await idleTrimmedSession();
		const handler = connect();
		try {
			await handler.ready;
			for (const command of ["get_entries", "get_tree"]) {
				// when
				await handler.handleInputLine(JSON.stringify({ type: command, id: command }));

				// then
				const response = records.find((record) => record.id === command);
				expect(response).toMatchObject({ success: true });
				expect(JSON.stringify(response)).toContain("first request");
				expect(harness.sessionManager.holdsMaterializedHistory()).toBe(false);
			}
		} finally {
			await handler.dispose();
		}
	});

	it("lets go of the history its bind read once the connection is ready", async () => {
		// given an idle trimmed session whose full history a reader already materialized
		const { harness, connect } = await idleTrimmedSession();
		harness.sessionManager.getEntries();
		expect(harness.sessionManager.holdsMaterializedHistory()).toBe(true);

		// when
		const handler = connect();
		try {
			await handler.ready;

			// then
			expect(harness.sessionManager.holdsMaterializedHistory()).toBe(false);
		} finally {
			await handler.dispose();
		}
	});
});
