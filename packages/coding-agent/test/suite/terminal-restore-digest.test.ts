import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

/**
 * Passthrough counters so the tests can prove ordering and call discipline
 * (manifest read, restore invocation, handler calls, checkpoint flush, spawn)
 * without stubbing any behavior away.
 */
const trackers = vi.hoisted(() => ({
	restoreCalls: 0,
	handlerCalls: 0,
	writerFlushes: 0,
	spawnCalls: 0,
}));

vi.mock("../../src/core/extensions/builtin/terminal/restore.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/core/extensions/builtin/terminal/restore.ts")>();
	return {
		...original,
		restoreTerminalState: async (options: Parameters<typeof original.restoreTerminalState>[0]) => {
			trackers.restoreCalls += 1;
			let forwarded = options;
			const handlers = options.handlers;
			if (handlers) {
				const wrapped: Record<string, unknown> = {};
				for (const [key, handler] of Object.entries(handlers)) {
					wrapped[key] = (monitor: unknown) => {
						trackers.handlerCalls += 1;
						return (handler as (monitor: unknown) => unknown)(monitor);
					};
				}
				forwarded = { ...options, handlers: wrapped } as typeof options;
			}
			return original.restoreTerminalState(forwarded);
		},
	};
});

vi.mock("../../src/core/extensions/builtin/terminal/terminal-manifest.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/core/extensions/builtin/terminal/terminal-manifest.ts")>();
	return {
		...original,
		TerminalManifestWriter: class extends original.TerminalManifestWriter {
			recordShutdown(): Promise<void> {
				trackers.writerFlushes += 1;
				return super.recordShutdown();
			}
		},
	};
});

vi.mock("../../src/core/extensions/builtin/terminal/tools/spawn.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/core/extensions/builtin/terminal/tools/spawn.ts")>();
	return {
		...original,
		spawnCommandSession: (...args: Parameters<typeof original.spawnCommandSession>) => {
			trackers.spawnCalls += 1;
			return original.spawnCommandSession(...args);
		},
	};
});

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
	details?: { bash_id?: string };
}

interface ToolLike {
	name: string;
	execute: (id: string, input: Record<string, unknown>) => Promise<ToolResultLike>;
}

interface SentMessage {
	message: { customType: string; content: string; display: boolean };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

/** One extension-runner generation, mirroring how AgentSession.reload() swaps runners. */
interface Generation {
	pi: ExtensionAPI;
	tools: Map<string, ToolLike>;
	sent: SentMessage[];
	userMessages: string[];
	emit(eventType: string, payload: Record<string, unknown>): Promise<void>;
}

function firstText(result: ToolResultLike | undefined): string {
	return result?.content.find((block) => block.type === "text")?.text ?? "";
}

function createGeneration(cwd: string, sessionId: string, sessionDir: string): Generation {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolLike>();
	const sent: SentMessage[] = [];
	const userMessages: string[] = [];
	let activeTools: string[] = [];
	const pi = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		on: (eventType: string, handler: Handler) => {
			const registered = handlers.get(eventType) ?? [];
			registered.push(handler);
			handlers.set(eventType, registered);
		},
		sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) => {
			sent.push({ message, options });
		},
		sendUserMessage: (content: string) => userMessages.push(String(content)),
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;
	const ctx: ExtensionContext = {
		cwd,
		mode: "tui",
		model: { id: "test-model", api: "openai-completions" },
		ui: { setStatus: () => {}, notify: () => {}, theme },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(sessionDir, `${sessionId}.jsonl`),
			getSessionDir: () => sessionDir,
		},
	} as unknown as ExtensionContext;
	return {
		pi,
		tools,
		sent,
		userMessages,
		async emit(eventType, payload) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
	};
}

function terminalMessages(generation: Generation): SentMessage[] {
	return generation.sent.filter((entry) => entry.message.customType === "senpi-terminal:notification");
}

function reminderContents(generation: Generation): string[] {
	return terminalMessages(generation).map((entry) => entry.message.content);
}

describe("terminal restore digest — lease, manifest restore, one resume digest", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionDir: string;
	let stateDir: string;
	let sessionId: string;
	let live: Generation[] = [];
	let extraChildren: Array<{ kill(): void }> = [];
	let counter = 0;

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-restore-digest-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		sessionDir = join(tmp, "sessions");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		writeFileSync(join(cwd, ".senpi", "settings.json"), JSON.stringify({ terminal: { notify: "wake" } }));
		sessionId = `restore-digest-${Date.now().toString(36)}-${++counter}`;
		stateDir = join(sessionDir, "extensions", "terminal");
		live = [];
		extraChildren = [];
		trackers.restoreCalls = 0;
		trackers.handlerCalls = 0;
		trackers.writerFlushes = 0;
		trackers.spawnCalls = 0;
	});

	afterEach(async () => {
		for (const generation of live) {
			await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
		for (const child of extraChildren) child.kill();
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	async function start(reason: string): Promise<Generation> {
		const generation = createGeneration(cwd, sessionId, sessionDir);
		registerTerminalExtension(generation.pi);
		live.push(generation);
		await generation.emit("session_start", { type: "session_start", reason });
		return generation;
	}

	function leasePath(): string {
		return join(stateDir, `${encodeURIComponent(sessionId)}.lease`);
	}

	function manifestPath(): string {
		return join(stateDir, `${encodeURIComponent(sessionId)}.json`);
	}

	async function startMonitor(generation: Generation, description: string): Promise<void> {
		const created = await generation.tools.get("monitor")?.execute(`mon-${description}`, {
			description,
			command: "cat",
			persistent: true,
		});
		expect(created?.isError, firstText(created)).toBeFalsy();
	}

	it("(a) restart after quit delivers exactly one digest naming every monitor and background session as lost", async () => {
		const gen1 = await start("startup");
		expect(gen1.sent).toHaveLength(0);
		trackers.restoreCalls = 0;
		await startMonitor(gen1, "watch alpha");
		await startMonitor(gen1, "watch beta");
		await startMonitor(gen1, "watch gamma");
		const background = await gen1.tools.get("bash")?.execute("bg-build", {
			command: "cat",
			description: "background build log",
			run_in_background: true,
		});
		expect(background?.isError).toBeFalsy();

		await gen1.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = [];
		expect(existsSync(manifestPath())).toBe(true);

		const gen2 = await start("resume");
		expect(trackers.restoreCalls).toBe(1);
		expect(reminderContents(gen2)).toEqual([
			"<system-reminder>Terminal state after restart: lost 4 (watch alpha, watch beta, watch gamma, background build log).</system-reminder>",
		]);
		expect(terminalMessages(gen2)).toHaveLength(1);
		expect(gen2.userMessages).toEqual([]);
	});

	it("(b) a reload start claims the parked bundle, sends no digest, and keeps the lease with the same pid", async () => {
		const gen1 = await start("startup");
		const created = await gen1.tools.get("bash")?.execute("bg-reload", {
			command: "sh -c 'echo before-reload-marker; cat'",
			run_in_background: true,
		});
		const bashId = created?.details?.bash_id;
		expect(bashId).toMatch(/^bash_\d+$/);
		expect(existsSync(leasePath())).toBe(true);
		trackers.restoreCalls = 0;

		await gen1.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		live = [];
		const gen2 = await start("reload");

		expect(trackers.restoreCalls).toBe(0);
		expect(terminalMessages(gen2)).toHaveLength(0);
		expect(existsSync(leasePath())).toBe(true);

		const peeked = await gen2.tools.get("bash_output")?.execute("peek-reload", {
			bash_id: bashId,
			view: "screen",
		});
		expect(peeked?.isError).toBeFalsy();
		expect(firstText(peeked)).toContain("before-reload-marker");
	});

	it("(c) a lease held by a live pid yields one attached-elsewhere reminder and zero spawns", async () => {
		const child = spawn("sleep", ["30"], { stdio: "ignore" });
		extraChildren.push(child);
		expect(child.pid).toBeDefined();
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(leasePath(), JSON.stringify({ pid: child.pid, startedAtMs: Date.now() }), "utf8");

		const generation = await start("resume");

		expect(reminderContents(generation)).toEqual([
			`<system-reminder>Terminal monitors for this session are attached in another live process (pid ${child.pid}); nothing was restored here.</system-reminder>`,
		]);
		expect(trackers.restoreCalls).toBe(0);
		expect(trackers.spawnCalls).toBe(0);
	});

	it("(d) a corrupt manifest yields one fail-closed reminder and no handler call", async () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(manifestPath(), "not-a-manifest{{{", "utf8");

		const generation = await start("resume");

		const contents = reminderContents(generation);
		expect(contents).toHaveLength(1);
		expect(contents[0]).toContain("corrupt");
		expect(contents[0]).toContain("<system-reminder>");
		expect(trackers.handlerCalls).toBe(0);
	});

	it("(e) notify mode off suppresses every message while the manifest is still read and the lease acquired", async () => {
		writeFileSync(join(cwd, ".senpi", "settings.json"), JSON.stringify({ terminal: { notify: "off" } }));
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			manifestPath(),
			JSON.stringify({
				version: 1,
				sessionId,
				monitors: [
					{
						monitorId: "mon_offseason000000001",
						sessionId,
						description: "muted watch",
						runtimeKind: "command",
						durabilityClass: "ephemeral",
						createdAt: Date.now(),
						expiresAt: null,
						persistent: false,
						suspended: true,
						lastCheckpoint: null,
						deliveryPaused: true,
						wakeCount: 0,
						fireWindow: { startMs: 1, count: 0 },
					},
				],
				backgroundSessions: [],
				updatedAt: Date.now(),
			}),
			"utf8",
		);

		const generation = await start("resume");

		expect(generation.sent).toHaveLength(0);
		expect(trackers.restoreCalls).toBeGreaterThanOrEqual(1);
		expect(existsSync(leasePath())).toBe(true);
	});

	it("(f) a non-reload shutdown flushes the manifest as suspended and releases the lease", async () => {
		const generation = await start("startup");
		await startMonitor(generation, "watch delta");
		await expect.poll(() => existsSync(manifestPath()), { timeout: 3000 }).toBe(true);
		expect(existsSync(leasePath())).toBe(true);

		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = [];

		expect(trackers.writerFlushes).toBeGreaterThanOrEqual(1);
		expect(existsSync(leasePath())).toBe(false);
		const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
			monitors: Array<{ description: string; suspended: boolean }>;
		};
		expect(
			manifest.monitors.map((entry) => ({ description: entry.description, suspended: entry.suspended })),
		).toEqual([{ description: "watch delta", suspended: true }]);
	});
});
