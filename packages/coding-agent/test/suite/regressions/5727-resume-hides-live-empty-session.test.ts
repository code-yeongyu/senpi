import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionListProgress } from "../../../src/core/session-discovery.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../../../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

// senpi#5727: the TUI writes the live session's header at startup (persistHeaderNow, plus
// startupBookkeeping entries), so the session the person is sitting in has a file before it has a
// conversation. /resume listed it as the newest row "(no messages)", the untouched selection sat on
// row 0, and Enter switched onto the session already open: "Resumed session" on an empty screen.

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function sessionDir(): string {
	dir = mkdtempSync(join(tmpdir(), "senpi-5727-"));
	return dir;
}

async function pastSession(root: string, prompt: string, at: number): Promise<string> {
	const manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: prompt, timestamp: at });
	manager.appendMessage({ ...fauxAssistantMessage(`reply to ${prompt}`), timestamp: at + 1 });
	await manager.persistHeaderNow();
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("no session file");
	return file;
}

async function liveStartedSession(root: string): Promise<SessionManager> {
	const manager = SessionManager.create(root, root);
	await manager.persistHeaderNow();
	manager.appendCustomEntry("pi-rules.scan", { cwd: root, reason: "startup" }, { startupBookkeeping: true });
	manager.appendCustomEntry("senpi-memory.session-binding", { identity: "work" }, { startupBookkeeping: true });
	return manager;
}

async function openSelector(root: string, live: SessionManager, selected: string[]) {
	const loads: Promise<unknown>[] = [];
	const list = (onProgress?: SessionListProgress, signal?: AbortSignal) => {
		const load = SessionManager.list(root, root, onProgress, signal);
		loads.push(load);
		return load;
	};
	const all = (onProgress?: SessionListProgress, signal?: AbortSignal) => {
		const load = SessionManager.listAll(root, onProgress, signal);
		loads.push(load);
		return load;
	};
	const selector = new SessionSelectorComponent(
		list,
		all,
		(path) => selected.push(path),
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager() },
		live.getSessionFile(),
	);
	await Promise.all(loads);
	await flushPromises();
	return selector;
}

describe("/resume never offers the live session while it holds no conversation (#5727)", () => {
	it("lists only resumable sessions and Enter resumes the newest one", async () => {
		const root = sessionDir();
		const now = Date.now();
		await pastSession(root, "older work", now - 7_200_000);
		const newest = await pastSession(root, "latest work", now - 3_600_000);
		const live = await liveStartedSession(root);

		const selected: string[] = [];
		const selector = await openSelector(root, live, selected);

		const screen = stripAnsi(selector.render(120).join("\n"));
		expect(screen).toContain("latest work");
		expect(screen).toContain("older work");
		expect(screen).not.toContain("(no messages)");

		selector.getSessionList().handleInput("\r");
		expect(selected).toEqual([newest]);
	});

	it("keeps the live session listed once it has a conversation", async () => {
		const root = sessionDir();
		await pastSession(root, "older work", Date.now() - 3_600_000);
		const live = await liveStartedSession(root);
		live.appendMessage({ role: "user", content: "live question", timestamp: Date.now() });

		const selector = await openSelector(root, live, []);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("live question");
	});
});
