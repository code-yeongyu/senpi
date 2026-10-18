import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface Generation {
	readonly emit: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
	readonly sent: Array<{ customType: string; content: string }>;
}

function createGeneration(mode: string, cwd: string, sessionId: string, sessionDir: string): Generation {
	const handlers = new Map<string, Handler[]>();
	const sent: Generation["sent"] = [];
	let activeTools: string[] = [];
	const pi = {
		registerTool: () => {},
		registerMessageRenderer: () => {},
		on: (eventType: string, handler: Handler) => {
			handlers.set(eventType, [...(handlers.get(eventType) ?? []), handler]);
		},
		sendMessage: (message: { customType: string; content: string }) => {
			sent.push(message);
		},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		mode,
		model: { id: "test-model", api: "openai-completions" },
		ui: { setStatus: () => {}, notify: () => {}, theme },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
			getSessionDir: () => sessionDir,
		},
	} as unknown as ExtensionContext;
	registerTerminalExtension(pi);
	return {
		sent,
		async emit(eventType, payload) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
	};
}

function persistedManifest(sessionId: string): Record<string, unknown> {
	return {
		version: 1,
		sessionId,
		monitors: [
			{
				monitorId: "mon_ONESHOT000000001",
				sessionId,
				description: "standing watch",
				runtimeKind: "command",
				durabilityClass: "restartable-command",
				command: "sleep 30",
				cwd: tmpdir(),
				createdAt: Date.now() - 60_000,
				expiresAt: Date.now() + 6 * 86_400_000,
				persistent: true,
				suspended: true,
				lastCheckpoint: null,
				deliveryPaused: false,
				fireWindow: { startMs: Date.now() - 60_000, count: 0 },
			},
		],
		backgroundSessions: [],
		updatedAt: Date.now() - 30_000,
	};
}

describe("terminal persistence in one-shot modes", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionDir: string;
	let stateDir: string;
	let sessionId: string;
	let counter = 0;

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-one-shot-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		sessionDir = join(tmp, "sessions");
		stateDir = join(sessionDir, "extensions", "terminal");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		mkdirSync(stateDir, { recursive: true });
		sessionId = `one-shot-${Date.now().toString(36)}-${++counter}`;
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	for (const mode of ["print", "json"]) {
		it(`${mode} mode leaves an existing manifest byte-identical, creates no lease and restores nothing`, async () => {
			const manifestPath = join(stateDir, `${sessionId}.json`);
			const before = JSON.stringify(persistedManifest(sessionId));
			writeFileSync(manifestPath, before, "utf8");

			const generation = createGeneration(mode, cwd, sessionId, sessionDir);
			await generation.emit("session_start", { type: "session_start", reason: "startup" });
			await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

			expect(readFileSync(manifestPath, "utf8")).toBe(before);
			expect(existsSync(join(stateDir, `${sessionId}.lease`))).toBe(false);
			expect(readdirSync(stateDir)).toEqual([`${sessionId}.json`]);
			expect(generation.sent.filter((message) => message.content.includes("Terminal state after restart"))).toEqual(
				[],
			);
		});
	}

	it("tui mode with the same manifest acquires the lease and rewrites the manifest", async () => {
		const manifestPath = join(stateDir, `${sessionId}.json`);
		const before = JSON.stringify(persistedManifest(sessionId));
		writeFileSync(manifestPath, before, "utf8");

		const generation = createGeneration("tui", cwd, sessionId, sessionDir);
		await generation.emit("session_start", { type: "session_start", reason: "startup" });
		expect(existsSync(join(stateDir, `${sessionId}.lease`))).toBe(true);
		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(existsSync(join(stateDir, `${sessionId}.lease`))).toBe(false);
		expect(readFileSync(manifestPath, "utf8")).not.toBe(before);
	});
});
