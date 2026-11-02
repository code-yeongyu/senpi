import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_CACHE_PREWARM_ENTRY_TYPE } from "../../../src/core/extensions/builtin/cache-keepalive/prewarm-entry.ts";
import { TODO_STATE_ENTRY_TYPE } from "../../../src/core/extensions/builtin/todotools/todo-types.ts";
import type { ExtensionFactory } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness } from "../harness.ts";

// senpi#3263: a TUI session writes its header at startup (control endpoint), and extensions then
// append custom entries (rules scan, memory binding). Closing without chatting must still remove
// the file, because the session holds no user or assistant message - the same rule that keeps a
// new session in memory until its first message (#10000).

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function startedSession(): { manager: SessionManager; file: string } {
	dir = mkdtempSync(join(tmpdir(), "senpi-3263-"));
	const manager = SessionManager.create(dir, dir);
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("no session file");
	return { manager, file };
}

describe("closing a session without a conversation leaves no file (#3263)", () => {
	it("discards a header-only file that extensions added startup bookkeeping to", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] }, { startupBookkeeping: true });
		manager.appendCustomEntry("repository-identity", { root: "/r" }, { startupBookkeeping: true });
		expect(existsSync(file)).toBe(true);

		expect(await manager.discardHeaderOnlyFile()).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(manager.isTranscriptFlushed()).toBe(false);
	});

	it("keeps the file once the session has a user message", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] });
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("keeps the file once the session has an assistant message", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendMessage(fauxAssistantMessage("reply"));

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("keeps the file once a delivered message reached the model context", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomMessageEntry("session_control_delivery", "from outside", true, { delivery_id: "d1" });

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("keeps a shell command the user ran before the first prompt", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendMessage({
			role: "bashExecution",
			command: "git status",
			output: "clean",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("keeps a file whose custom entry was not marked as startup bookkeeping", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("senpi-memory.session-binding", { agent: "test" });

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("persists the startup bookkeeping mark on the entry", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] }, { startupBookkeeping: true });
		manager.appendCustomEntry("plain-state", { n: 1 });

		const entries = SessionManager.open(file, dir).getEntries();
		expect(entries.map((entry) => (entry.type === "custom" ? entry.startupBookkeeping : "other"))).toEqual([
			true,
			undefined,
		]);
	});

	it("keeps the cost record of a paid prompt-cache prewarm", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry(PROMPT_CACHE_PREWARM_ENTRY_TYPE, {
			phase: "warmed",
			usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 4000, totalTokens: 4010 },
		});

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("keeps extension state the user created, such as a todo list", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, { schema: "v2", phases: [] });

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("keeps a session the user named", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendSessionInfo("planning");

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("never deletes a file it reopened from disk, even one holding only startup bookkeeping", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] }, { startupBookkeeping: true });

		const reopened = SessionManager.open(file, dir);
		expect(await reopened.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("writes the buffered custom entries again once a conversation starts after the discard", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] }, { startupBookkeeping: true });
		await manager.discardHeaderOnlyFile();

		manager.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
		expect(existsSync(file)).toBe(true);
		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntries().map((entry) => entry.type)).toEqual(["custom", "message"]);
	});
});

describe("extensions mark startup bookkeeping through pi.appendEntry (#3263)", () => {
	it("persists the option an extension passes", async () => {
		const extension: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "noop",
				label: "noop",
				description: "noop",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			});
			pi.on("session_start", () => {
				pi.appendEntry("ext.scan", { ok: true }, { startupBookkeeping: true });
				pi.appendEntry("ext.state", { ok: true });
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		try {
			await harness.session.bindExtensions({});
			const custom = harness.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType.startsWith("ext."));
			expect(
				custom.map((entry) => (entry.type === "custom" ? [entry.customType, entry.startupBookkeeping] : [])),
			).toEqual([
				["ext.scan", true],
				["ext.state", undefined],
			]);
		} finally {
			harness.cleanup();
		}
	});
});
