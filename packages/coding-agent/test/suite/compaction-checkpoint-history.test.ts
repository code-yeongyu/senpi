import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentCheckpoint,
	captureAgentCheckpoint,
} from "../../src/core/extensions/builtin/compaction/checkpoint-state.ts";
import { loadEntriesFromFile, setSessionEntryLoaderForTesting } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const cases: { name: string; markers: unknown[]; expected: string | null }[] = [
	{ name: "no agent marker", markers: [], expected: null },
	{ name: "an older agent marker", markers: [{ agentName: "older" }], expected: "older" },
	{
		name: "the newest agent marker",
		markers: [{ agentName: "older" }, { agent: "newer" }],
		expected: "newer",
	},
	{
		name: "agentName taking precedence over agent",
		markers: [{ agentName: "preferred", agent: "fallback" }],
		expected: "preferred",
	},
	{
		name: "an invalid agentName with a valid agent",
		markers: [{ agentName: 42, agent: "fallback" }],
		expected: "fallback",
	},
	{ name: "an empty agentName", markers: [{ agentName: "", agent: "fallback" }], expected: "" },
];

describe("compaction checkpoint history capture", () => {
	it.each(cases)("loads full history once with $name", async ({ markers, expected }) => {
		// Given a persisted session with a trimmed mirror and metadata outside the active branch.
		let checkpoint: AgentCheckpoint | undefined;
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						checkpoint = captureAgentCheckpoint(pi, ctx);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const session = harness.sessionManager;
		const rootId = session.appendMessage(assistantMsg("ready"));
		for (const marker of markers) session.appendCustomEntry("agent-state", marker);
		session.branch(rootId);
		for (const data of [null, "not metadata", { agentName: 42, agent: false }]) {
			session.appendCustomEntry("unrelated", data);
		}
		for (let index = 0; index < 24; index++) session.appendMessage(userMsg(`history ${index}`));
		const firstKeptId = session.appendMessage(userMsg("retained"));
		session.appendCustomMessageEntry("agent-state", "not a custom entry", false, { agentName: "ignored" });
		session.appendCompaction("summary", firstKeptId, 100);

		let fullHistoryLoads = 0;
		const restoreLoader = setSessionEntryLoaderForTesting((filePath) => {
			fullHistoryLoads++;
			return loadEntriesFromFile(filePath);
		});
		try {
			// When the exported capture runs with the real extension API and session manager.
			await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });

			// Then selection semantics are unchanged and even a missing marker costs one disk load.
			expect(checkpoint?.agentName).toBe(expected);
			expect(fullHistoryLoads).toBe(1);
		} finally {
			restoreLoader();
		}
	});
});
