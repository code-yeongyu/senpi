import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	getAssistantText,
	MOCK_MODEL,
	MOCK_PROVIDER,
	type RpcHermeticSession,
	readSessionEntries,
	startHermeticRpcSession,
	waitForSessionWrites,
} from "./helpers/rpc-hermetic.ts";

describe("RPC mode", () => {
	let session: RpcHermeticSession | undefined;
	let client: RpcHermeticSession["client"];

	beforeEach(async () => {
		session = await startHermeticRpcSession();
		client = session.client;
	});

	afterEach(async () => {
		await session?.close();
		session = undefined;
	});

	test("should get state", async () => {
		await client.start();
		const state = await client.getState();

		expect(state.model).toBeDefined();
		expect(state.model?.provider).toBe(MOCK_PROVIDER);
		expect(state.model?.id).toBe(MOCK_MODEL);
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
	}, 30000);

	test("should save messages to session file", async () => {
		await client.start();

		const events = await client.promptAndWait("Reply with just the word 'hello'");
		const messageEndEvents = events.filter((event) => event.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThanOrEqual(2);

		await waitForSessionWrites();
		const entries = readSessionEntries(activeSessionDir());
		expect(entries[0]?.type).toBe("session");

		const messages = entries.filter((entry) => entry.type === "message");
		expect(messages.length).toBeGreaterThanOrEqual(2);
		expect(messages.map((entry) => entry.message?.role)).toContain("user");
		expect(messages.map((entry) => entry.message?.role)).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		await client.start();

		await client.promptAndWait("Say hello");
		await client.promptAndWait("Say hello again");

		const result = await client.compact();
		expect(result.summary).toBeDefined();
		expect(result.tokensBefore).toBeGreaterThan(0);

		await waitForSessionWrites();
		const entries = readSessionEntries(activeSessionDir());
		const compactionEntries = entries.filter((entry) => entry.type === "compaction");
		expect(compactionEntries.length).toBe(1);
		expect(compactionEntries[0]?.summary).toBeDefined();
	}, 120000);

	test("should execute bash command", async () => {
		await client.start();

		const result = await client.bash("echo hello");
		expect(result.output.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	}, 30000);

	test("should add bash output to context", async () => {
		await client.start();

		await client.promptAndWait("Say hi");
		const uniqueValue = `test-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		await waitForSessionWrites();
		const entries = readSessionEntries(activeSessionDir());
		const bashMessages = entries.filter(
			(entry) => entry.type === "message" && entry.message?.role === "bashExecution",
		);
		expect(bashMessages.length).toBe(1);
		expect(bashMessages[0]?.message?.output).toContain(uniqueValue);
	}, 90000);

	test("should include bash output in LLM context", async () => {
		await client.start();

		const uniqueValue = `unique-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		const events = await client.promptAndWait(
			"What was the exact output of the echo command I just ran? Reply with just the value, nothing else.",
		);

		expect(getAssistantText(events)).toContain(uniqueValue);
	}, 90000);

	test("should set and get thinking level", async () => {
		await client.start();

		await client.setThinkingLevel("high");

		const state = await client.getState();
		expect(state.thinkingLevel).toBe("high");
	}, 30000);

	test("should cycle thinking level", async () => {
		await client.start();

		const initialState = await client.getState();
		const initialLevel = initialState.thinkingLevel;

		const result = await client.cycleThinkingLevel();
		if (result == null) {
			throw new Error("Expected thinking level cycle result");
		}
		expect(result.level).not.toBe(initialLevel);

		const newState = await client.getState();
		expect(newState.thinkingLevel).toBe(result.level);
	}, 30000);

	test("should get available thinking levels", async () => {
		await client.start();

		const levels = await client.getAvailableThinkingLevels();
		expect(levels.length).toBeGreaterThan(0);

		// The current level reported by get_state must be in the available list
		const state = await client.getState();
		expect(levels).toContain(state.thinkingLevel);

		// cycle_thinking_level must only ever land on levels from get_available_thinking_levels
		const initialLevel = state.thinkingLevel;
		const cycled = await client.cycleThinkingLevel();
		if (cycled) {
			expect(levels).toContain(cycled.level);
			// distinct cycle step (unless only one level)
			if (levels.length > 1) {
				expect(cycled.level).not.toBe(initialLevel);
			}
		}
	}, 30000);

	test("should get available models", async () => {
		await client.start();

		const models = await client.getAvailableModels();
		expect(models.length).toBeGreaterThan(0);

		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	}, 30000);

	test("should get session stats", async () => {
		await client.start();

		await client.promptAndWait("Hello");

		const stats = await client.getSessionStats();
		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	}, 90000);

	test("should create new session", async () => {
		await client.start();

		await client.promptAndWait("Hello");

		let state = await client.getState();
		expect(state.messageCount).toBeGreaterThan(0);

		await client.newSession();

		state = await client.getState();
		expect(state.messageCount).toBe(0);
	}, 90000);

	test("should export to HTML", async () => {
		await client.start();

		await client.promptAndWait("Hello");

		const result = await client.exportHtml();
		expect(result.path).toBeDefined();
		expect(result.path.endsWith(".html")).toBe(true);
		expect(existsSync(result.path)).toBe(true);
	}, 90000);

	test("should get last assistant text", async () => {
		await client.start();

		let text = await client.getLastAssistantText();
		expect(text).toBeUndefined();

		await client.promptAndWait("Reply with just: test123");

		text = await client.getLastAssistantText();
		expect(text).toContain("test123");
	}, 90000);

	test("should get session entries with since cursor", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		expect(entries.length).toBeGreaterThanOrEqual(2);
		for (const entry of entries) {
			expect(entry.id).toBeDefined();
		}
		const lastEntry = entries[entries.length - 1];
		expect(leafId).toBe(lastEntry?.id);

		const firstEntry = entries[0];
		if (firstEntry === undefined) {
			throw new Error("Expected at least one session entry");
		}
		const since = await client.getEntries(firstEntry.id);
		expect(since.entries.map((entry) => entry.id)).toEqual(entries.slice(1).map((entry) => entry.id));
		expect(since.leafId).toBe(leafId);

		await expect(client.getEntries("nonexistent-id")).rejects.toThrow("Entry not found");
	}, 90000);

	test("should get session tree", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		const { tree, leafId: treeLeafId } = await client.getTree();
		expect(treeLeafId).toBe(leafId);

		expect(tree.length).toBe(1);
		const chainIds: string[] = [];
		let nodes = tree;
		while (nodes.length === 1) {
			const node = nodes[0];
			if (node === undefined) {
				throw new Error("Expected a session tree node");
			}
			chainIds.push(node.entry.id);
			nodes = node.children;
		}
		expect(nodes.length).toBe(0);
		expect(chainIds).toEqual(entries.map((entry) => entry.id));
	}, 90000);

	test("should retain pre-compaction entries in get_entries", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");
		await client.promptAndWait("Reply with just 'ok' again");
		const before = await client.getEntries();

		await client.compact();

		const after = await client.getEntries();
		expect(after.entries.slice(0, before.entries.length).map((entry) => entry.id)).toEqual(
			before.entries.map((entry) => entry.id),
		);
		expect(after.entries.some((entry) => entry.type === "compaction")).toBe(true);
	}, 120000);

	test("should set and get session name", async () => {
		await client.start();

		let state = await client.getState();
		expect(state.sessionName).toBeUndefined();

		await client.promptAndWait("Reply with just 'ok'");
		await client.setSessionName("my-test-session");

		state = await client.getState();
		expect(state.sessionName).toBe("my-test-session");

		await waitForSessionWrites();
		const entries = readSessionEntries(activeSessionDir());
		const sessionInfoEntries = entries.filter((entry) => entry.type === "session_info");
		expect(sessionInfoEntries.length).toBe(1);
		expect(sessionInfoEntries[0]?.name).toBe("my-test-session");
	}, 60000);

	function activeSessionDir(): string {
		if (session === undefined) {
			throw new Error("Expected active RPC test session");
		}
		return session.sessionDir;
	}
});
