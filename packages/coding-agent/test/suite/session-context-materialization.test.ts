import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";

const ready: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "ready" }],
	api: "openai-completions",
	provider: "mock",
	model: "mock-model",
	stopReason: "stop",
	timestamp: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

describe("compact context materialization", () => {
	const sessions: SessionManager[] = [];
	const directories: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) session.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("materializes healthy entries once per read while preserving fresh message objects and positions", () => {
		const session = SessionManager.inMemory();
		sessions.push(session);
		const id = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "original" }],
			timestamp: 0,
		});
		session.appendMessage(ready);
		const materialize = vi.spyOn(session.getResidentStore(), "materialize");

		const first = session.buildSessionContext().messages;
		expect(materialize).toHaveBeenCalledTimes(2);
		expect(session.getMessageEntryPosition(first[0]!)).toMatchObject({ entryId: id });
		const firstMessage = first[0]!;
		if (firstMessage.role !== "user") throw new Error("Expected user message");
		firstMessage.content = "changed externally";

		materialize.mockClear();
		const second = session.buildSessionContext().messages;
		expect(materialize).toHaveBeenCalledTimes(2);
		expect(second[0]).not.toBe(first[0]);
		const secondMessage = second[0]!;
		if (secondMessage.role !== "user") throw new Error("Expected user message");
		expect(secondMessage.content).toEqual([{ type: "text", text: "original" }]);
		expect(session.getMessageEntryPosition(second[0]!)).toMatchObject({ entryId: id });
	});

	it.each(["missing", "corrupt"])("repairs %s blobs once without rematerializing healthy entries", (failure) => {
		const directory = mkdtempSync(join(tmpdir(), "context-materialize-"));
		directories.push(directory);
		const session = SessionManager.create(directory, directory);
		sessions.push(session);
		session.appendMessage(ready);
		const texts = ["a".repeat(40 * 1024), "b".repeat(40 * 1024), "c".repeat(40 * 1024)];
		for (const text of texts) {
			session.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
		}
		const store = session.getResidentStore();
		store.spillResident();
		const blobs = store.resolvedBlobsDir();
		if (!blobs) throw new Error("Expected persisted blob directory");
		const files = readdirSync(blobs).filter((file) => file.endsWith(".blob"));
		expect(files).toHaveLength(3);
		for (const file of files.slice(0, 2)) {
			if (failure === "missing") rmSync(join(blobs, file));
			else writeFileSync(join(blobs, file), "{corrupt");
		}
		const materialize = vi.spyOn(store, "materialize");
		const loadHistory = vi.fn(loadEntriesFromFile);
		const restoreLoader = setSessionEntryLoaderForTesting(loadHistory);
		try {
			const first = session.buildSessionContext().messages;
			expect(first.slice(1).map((message) => (message.role === "user" ? message.content : undefined))).toEqual(
				texts.map((text) => [{ type: "text", text }]),
			);
			expect(loadHistory).toHaveBeenCalledTimes(1);
			expect(materialize).toHaveBeenCalledTimes(6);
			materialize.mockClear();
			const second = session.buildSessionContext().messages;
			expect(second).toEqual(first);
			expect(loadHistory).toHaveBeenCalledTimes(1);
			expect(materialize).toHaveBeenCalledTimes(4);
		} finally {
			restoreLoader();
		}
	});
});
