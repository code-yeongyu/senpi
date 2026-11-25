import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const SENTINEL_PREFIX = "\\u0000senpi-resident-string:v1:";

function largeText(label: string): string {
	return `${label}: ${"x".repeat(40 * 1024)}`;
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

function imageToolResultMessage(imageData: string, detailsData: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-image-1",
		toolName: "computer",
		content: [{ type: "image", data: imageData, mimeType: "image/png" }],
		details: {
			screenshotMetadata: {
				data: detailsData,
				width: 1024,
				height: 768,
			},
		},
		isError: false,
		timestamp: 3,
	};
}

function providerNativeAssistantMessage(raw: unknown): AssistantMessage {
	return {
		...assistantMessage("provider native payload"),
		content: [{ type: "providerNative", subtype: "test", raw }],
	};
}

function defined<T>(value: T | undefined, name: string): T {
	if (value === undefined) {
		throw new Error(`${name} should be defined`);
	}
	return value;
}

// A reopen keeps its large strings as tokens in the mirror: paged from the file since senpi#3968, not in the store.
function residentMirrorJson(session: SessionManager): string {
	return JSON.stringify((session as unknown as { fileEntries: unknown[] }).fileEntries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("SessionManager resident retention", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-resident-retention-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("bounds resident strings while materializing public readers and persisted JSONL", () => {
		const userText = largeText("user");
		const assistantText = largeText("assistant");
		const session = SessionManager.create(tempDir, tempDir);

		const userId = session.appendMessage({ role: "user", content: userText, timestamp: 1 });
		const assistantId = session.appendMessage(assistantMessage(assistantText));

		expect(session.getResidentStoreStats().blobCount).toBeGreaterThanOrEqual(2);

		const userEntry = session.getEntry(userId);
		expect(userEntry?.type).toBe("message");
		if (userEntry?.type === "message") {
			if (!("content" in userEntry.message)) {
				throw new Error("user message should have content");
			}
			expect(userEntry.message.content).toBe(userText);
		}

		const assistantEntry = session.getEntry(assistantId);
		expect(assistantEntry?.type).toBe("message");
		if (assistantEntry?.type === "message") {
			if (!("content" in assistantEntry.message) || !Array.isArray(assistantEntry.message.content)) {
				throw new Error("assistant message should have content blocks");
			}
			const firstBlock = assistantEntry.message.content[0];
			expect(firstBlock?.type).toBe("text");
			if (firstBlock?.type !== "text") {
				throw new Error("assistant content should start with text");
			}
			expect(firstBlock.text).toBe(assistantText);
		}

		const branch = session.getBranch();
		expect(JSON.stringify(branch)).not.toContain(SENTINEL_PREFIX);
		expect(JSON.stringify(session.getEntries())).not.toContain(SENTINEL_PREFIX);

		const context = session.buildSessionContext();
		expect(context.messages[0]).toEqual({ role: "user", content: userText, timestamp: 1 });
		expect(JSON.stringify(context.messages[1])).toContain(assistantText);

		const sessionFile = defined(session.getSessionFile(), "session file");
		expect(existsSync(sessionFile)).toBe(true);
		const persisted = readFileSync(sessionFile, "utf8");
		expect(persisted).not.toContain(SENTINEL_PREFIX);
		expect(persisted).toContain(userText);
		expect(persisted).toContain(assistantText);
	});

	it("materializes reloads, branched sessions, and forked sessions without leaking sentinels", () => {
		const firstText = largeText("first");
		const secondText = largeText("second");
		const session = SessionManager.create(tempDir, tempDir);
		const firstId = session.appendMessage({ role: "user", content: firstText, timestamp: 1 });
		const firstAssistantId = session.appendMessage(assistantMessage("small assistant"));
		const secondId = session.appendMessage({ role: "user", content: secondText, timestamp: 3 });
		session.appendMessage(assistantMessage("second assistant"));

		const sessionFile = defined(session.getSessionFile(), "session file");

		const reloaded = SessionManager.open(sessionFile, tempDir);
		expect(residentMirrorJson(reloaded).split(SENTINEL_PREFIX).length - 1).toBeGreaterThanOrEqual(2);
		expect(reloaded.buildSessionContext().messages[0]).toEqual({ role: "user", content: firstText, timestamp: 1 });

		const branchedFile = defined(reloaded.createBranchedSession(firstAssistantId), "branched file");
		expect(readFileSync(branchedFile, "utf8")).not.toContain(SENTINEL_PREFIX);
		expect(reloaded.buildSessionContext().messages[0]).toEqual({ role: "user", content: firstText, timestamp: 1 });
		expect(JSON.stringify(reloaded.buildSessionContext().messages)).not.toContain(secondText);

		const forked = SessionManager.forkFrom(sessionFile, join(tempDir, "forked-cwd"), tempDir, {
			id: "resident-fork",
		});
		const forkedContext = forked.buildSessionContext();
		expect(JSON.stringify(forkedContext.messages)).toContain(firstText);
		expect(JSON.stringify(forkedContext.messages)).toContain(secondText);
		const forkedFile = defined(forked.getSessionFile(), "forked file");
		expect(readFileSync(forkedFile, "utf8")).not.toContain(SENTINEL_PREFIX);
		expect(secondId).toBeTruthy();
		expect(firstId).toBeTruthy();
	});

	it("serves public readers without reserializing materialized large resident strings", () => {
		const imageData = largeText("image-data");
		const detailsData = largeText("details-data");
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "capture the screen", timestamp: 1 });
		session.appendMessage(assistantMessage("using the computer tool"));
		session.appendMessage(imageToolResultMessage(imageData, detailsData));

		const sessionFile = defined(session.getSessionFile(), "session file");
		const reloaded = SessionManager.open(sessionFile, tempDir);
		expect(residentMirrorJson(reloaded).split(SENTINEL_PREFIX).length - 1).toBeGreaterThanOrEqual(2);

		const originalStringify = JSON.stringify;
		const stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
			const rendered = originalStringify(value, replacer, space);
			if (rendered?.includes(imageData) || rendered?.includes(detailsData)) {
				throw new Error("public session readers should not JSON.stringify full resident payloads");
			}
			return rendered;
		});

		try {
			const entries = reloaded.getEntries();
			const toolResultEntry = entries.find(
				(entry) => entry.type === "message" && entry.message.role === "toolResult",
			);
			if (toolResultEntry?.type !== "message" || toolResultEntry.message.role !== "toolResult") {
				throw new Error("tool result entry should be present");
			}
			expect(toolResultEntry.message.content[0]).toEqual({ type: "image", data: imageData, mimeType: "image/png" });
			expect(toolResultEntry.message.details).toEqual({
				screenshotMetadata: {
					data: detailsData,
					width: 1024,
					height: 768,
				},
			});
			expect(reloaded.buildSessionContext().messages).toHaveLength(3);
		} finally {
			stringifySpy.mockRestore();
		}
	});

	it("preserves JSON toJSON redaction semantics while externalizing large strings", () => {
		const publicText = largeText("to-json-public");
		const createdAt = new Date("2026-06-26T00:00:00.000Z");
		const sparseArray: string[] = [];
		sparseArray.length = 3;
		sparseArray[0] = publicText;
		sparseArray[2] = "tail";
		const rawPayload = {
			createdAt,
			secret: "should not survive toJSON",
			toJSON: () => ({
				array: [undefined, Number.NaN, publicText],
				createdAt,
				nested: { omitted: undefined, visible: "kept" },
				publicText,
				sparseArray,
			}),
		};
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(providerNativeAssistantMessage(rawPayload));

		expect(session.getResidentStoreStats().blobCount).toBeGreaterThanOrEqual(1);
		const sessionFile = defined(session.getSessionFile(), "session file");
		const persisted = readFileSync(sessionFile, "utf8");
		expect(persisted).toContain(publicText);
		expect(persisted).not.toContain("should not survive toJSON");
		expect(persisted).not.toContain(SENTINEL_PREFIX);

		const entry = defined(session.getEntries()[0], "provider native entry");
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			throw new Error("provider native assistant entry should be present");
		}
		const content = defined(entry.message.content[0], "provider native content");
		if (content.type !== "providerNative" || !isRecord(content.raw)) {
			throw new Error("provider native raw should be materialized as a record");
		}
		expect(content.raw.publicText).toBe(publicText);
		expect(content.raw.createdAt).toBe("2026-06-26T00:00:00.000Z");
		expect(content.raw.secret).toBeUndefined();
		expect(content.raw.array).toEqual([null, null, publicText]);
		expect(content.raw.nested).toEqual({ visible: "kept" });
		expect(content.raw.sparseArray).toEqual([publicText, null, "tail"]);
	});

	it("preserves JSON object data properties named __proto__", () => {
		const protoText = largeText("proto-data-property");
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(
			providerNativeAssistantMessage({
				["__proto__"]: protoText,
				visible: "ok",
			}),
		);

		const entry = defined(session.getEntries()[0], "provider native entry");
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			throw new Error("provider native assistant entry should be present");
		}
		const content = defined(entry.message.content[0], "provider native content");
		if (content.type !== "providerNative" || !isRecord(content.raw)) {
			throw new Error("provider native raw should be materialized as a record");
		}

		expect(Object.hasOwn(content.raw, "__proto__")).toBe(true);
		expect(Reflect.get(content.raw, "__proto__")).toBe(protoText);
		expect(content.raw.visible).toBe("ok");
	});

	it("persists custom entry dates using JSON toJSON semantics", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const date = new Date("2026-06-26T12:34:56.789Z");
		session.appendMessage(assistantMessage("flush custom entries"));
		session.appendCustomEntry("date-payload", { date });

		const sessionFile = defined(session.getSessionFile(), "session file");
		const persisted = readFileSync(sessionFile, "utf8");
		expect(persisted).toContain('"date":"2026-06-26T12:34:56.789Z"');
		expect(persisted).not.toContain('"date":{}');

		const customEntry = session.getEntries().find((entry) => entry.type === "custom");
		if (customEntry?.type !== "custom" || !isRecord(customEntry.data)) {
			throw new Error("custom date entry should be present");
		}
		expect(customEntry.data.date).toBe("2026-06-26T12:34:56.789Z");
	});
});
