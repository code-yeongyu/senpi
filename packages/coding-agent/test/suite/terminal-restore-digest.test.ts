import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import {
	DURABLE_MONITOR_EXPIRY_MS,
	FIRE_BUDGET_AUTO_MUTE_SUMMARY,
} from "../../src/core/extensions/builtin/terminal/shared.ts";
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
	/** Every TerminalManifestWriter the extension constructs, so a test can await its own flush. */
	writers: [] as Array<{ flush(): Promise<void> }>,
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
			constructor(options: ConstructorParameters<typeof original.TerminalManifestWriter>[0]) {
				super(options);
				trackers.writers.push(this);
			}
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

/** The registry's own digest shape for a file below its 64 KiB sample window: `size:sha256(bytes)`. */
function fileCheckpoint(path: string, content: string) {
	const live = statSync(path);
	const bytes = Buffer.from(content);
	return {
		dev: live.dev,
		ino: live.ino,
		size: live.size,
		mtimeMs: live.mtimeMs,
		digest: `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`,
		present: true,
	};
}

function terminalMessages(generation: Generation): SentMessage[] {
	return generation.sent.filter((entry) => entry.message.customType === "senpi-terminal:notification");
}

function reminderContents(generation: Generation): string[] {
	return terminalMessages(generation).map((entry) => entry.message.content);
}

/** Monitor line/summary injections travel on their own custom type, not the terminal one. */
function monitorEventContents(generation: Generation): string[] {
	return generation.sent
		.filter((entry) => entry.message.customType === "senpi-monitor:notification")
		.map((entry) => entry.message.content);
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
		trackers.writers = [];
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

	/** A generation with the extension registered but not yet started, so a subscription can be installed before session_start fires. */
	function build(): Generation {
		const generation = createGeneration(cwd, sessionId, sessionDir);
		registerTerminalExtension(generation.pi);
		live.push(generation);
		return generation;
	}

	async function start(reason: string): Promise<Generation> {
		const generation = build();
		await generation.emit("session_start", { type: "session_start", reason });
		return generation;
	}

	/**
	 * Await the first monitor notification whose content satisfies `predicate`. The subscription
	 * wraps the generation's model-channel callback BEFORE the action that produces the event, so
	 * the await resolves on the production delivery itself, never on a timed retry. The channel
	 * is restored on first match, so later sends pass through untouched.
	 */
	function nextMonitorNotification(generation: Generation, predicate: (content: string) => boolean): Promise<string> {
		return new Promise((resolve) => {
			const channel = generation.pi as unknown as {
				sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) => void;
			};
			const forward = channel.sendMessage.bind(channel);
			channel.sendMessage = (message, options) => {
				if (message.customType === "senpi-monitor:notification" && predicate(message.content)) {
					channel.sendMessage = forward;
					resolve(message.content);
				}
				return forward(message, options);
			};
		});
	}

	/** Await the manifest writer's own drain, so a manifest file read right after is deterministic. */
	async function flushManifestWriters(): Promise<void> {
		await Promise.all(trackers.writers.map((writer) => writer.flush()));
	}

	function leasePath(): string {
		return join(stateDir, `${encodeURIComponent(sessionId)}.lease`);
	}

	function manifestPath(): string {
		return join(stateDir, `${encodeURIComponent(sessionId)}.json`);
	}

	interface ManifestFile {
		monitors: Array<{
			monitorId: string;
			description: string;
			suspended: boolean;
			createdAt: number;
			expiresAt: number | null;
		}>;
	}

	function readManifest(): ManifestFile {
		return JSON.parse(readFileSync(manifestPath(), "utf8")) as ManifestFile;
	}

	/** Descriptions as the manifest FILE currently holds them, in persisted order. */
	function manifestDescriptions(): string[] {
		if (!existsSync(manifestPath())) return [];
		return readManifest().monitors.map((entry) => entry.description);
	}

	async function startMonitor(generation: Generation, description: string): Promise<void> {
		const created = await generation.tools.get("monitor")?.execute(`mon-${description}`, {
			description,
			command: "cat",
			persistent: true,
		});
		expect(created?.isError, firstText(created)).toBeFalsy();
	}

	it("(a) restart after quit delivers exactly one digest naming every restored monitor and every lost background session", async () => {
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
		// The three persistent command monitors are durable, so the real restartable-command
		// handler brings them back; a background session carries no durable identity and is lost.
		expect(reminderContents(gen2)).toEqual([
			"<system-reminder>Terminal state after restart: restored 3 (watch alpha, watch beta, watch gamma); lost 1 (background build log).</system-reminder>",
		]);
		expect(terminalMessages(gen2)).toHaveLength(1);
		expect(gen2.userMessages).toEqual([]);
	});

	it("(a2) a durable monitor survives TWO consecutive restarts even though the middle generation persists again", async () => {
		// Generation 1: create the durable watch and shut down so it is persisted suspended.
		const gen1 = await start("startup");
		await startMonitor(gen1, "standing watch");
		await gen1.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = [];
		expect(manifestDescriptions()).toEqual(["standing watch"]);
		const persisted = readManifest().monitors[0];
		expect(persisted?.expiresAt).toBe((persisted?.createdAt ?? 0) + DURABLE_MONITOR_EXPIRY_MS);

		// Generation 2: the watch comes back, then something else persists the manifest. Before
		// re-adoption existed, that write rewrote the file from an in-memory map that never
		// contained the restored entry, erasing it.
		const gen2 = await start("resume");
		expect(reminderContents(gen2)).toEqual([
			"<system-reminder>Terminal state after restart: restored 1 (standing watch).</system-reminder>",
		]);
		await startMonitor(gen2, "second watch");
		// The intervening persist really landed on disk, and it kept the restored entry.
		await flushManifestWriters();
		expect(manifestDescriptions()).toEqual(["standing watch", "second watch"]);
		await gen2.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = [];
		expect(manifestDescriptions()).toEqual(["standing watch", "second watch"]);

		// Generation 3: the original durable monitor is STILL restored, not lost.
		const gen3 = await start("resume");
		expect(reminderContents(gen3)).toEqual([
			"<system-reminder>Terminal state after restart: restored 2 (standing watch, second watch).</system-reminder>",
		]);
		// The stable mon_ handle from generation 1 still resolves two restarts later.
		const standing = readManifest().monitors.find((entry) => entry.description === "standing watch");
		expect(standing?.monitorId).toBe(persisted?.monitorId);
		const peeked = await gen3.tools
			.get("bash_output")
			?.execute("peek-standing", { bash_id: standing?.monitorId, view: "screen" });
		expect(peeked?.isError, firstText(peeked)).toBeFalsy();
		// Two restarts later the deadline is still the one set at first registration: never extended.
		expect(standing?.createdAt).toBe(persisted?.createdAt);
		expect(standing?.expiresAt).toBe(persisted?.expiresAt);
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

	it("(g) the production restore path runs the REAL durable handlers: both entries come back restored", async () => {
		const watched = join(cwd, "durable-artifact.txt");
		writeFileSync(watched, "before-detach", "utf8");
		const checkpoint = fileCheckpoint(watched, "before-detach");
		// The file changes while no process is attached: the checkpointed-file handler must notice
		// it once on restore, which is only possible if the production path builds the real handler.
		writeFileSync(watched, "after-detach-change", "utf8");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			manifestPath(),
			JSON.stringify({
				version: 1,
				sessionId,
				monitors: [
					{
						monitorId: "mon_WIREDFILE00000001",
						sessionId,
						description: "durable artifact watch",
						runtimeKind: "file",
						durabilityClass: "checkpointed-file",
						path: watched,
						event: "modify",
						cwd,
						createdAt: Date.now() - 1000,
						expiresAt: null,
						persistent: true,
						suspended: true,
						lastCheckpoint: checkpoint,
						deliveryPaused: false,
						fireWindow: { startMs: 1, count: 0 },
					},
					{
						monitorId: "mon_WIREDCOMMAND00001",
						sessionId,
						description: "durable command watch",
						runtimeKind: "command",
						durabilityClass: "restartable-command",
						command: "cat",
						cwd,
						createdAt: Date.now() - 1000,
						expiresAt: null,
						persistent: true,
						suspended: true,
						lastCheckpoint: null,
						deliveryPaused: false,
						fireWindow: { startMs: 1, count: 0 },
					},
				],
				backgroundSessions: [],
				updatedAt: Date.now(),
			}),
			"utf8",
		);

		// Subscribe before the resume fires: the restore's detached-change report is the awaited event.
		const generation = build();
		const detachedChange = nextMonitorNotification(generation, (content) =>
			content.includes(`changed while detached: modified ${watched}`),
		);
		await generation.emit("session_start", { type: "session_start", reason: "resume" });

		expect(reminderContents(generation)).toContain(
			"<system-reminder>Terminal state after restart: restored 2 (durable artifact watch, durable command watch).</system-reminder>",
		);
		// Exactly one PTY for the restartable-command entry; the file watch spawns nothing.
		expect(trackers.spawnCalls).toBe(1);
		expect(trackers.handlerCalls).toBe(2);
		// The detached change is reported once through the registry's normal event sink.
		const notice = await detachedChange;
		expect(notice).toContain(`modified ${watched}`);
		expect(
			monitorEventContents(generation).filter((content) => content.includes("changed while detached")),
		).toHaveLength(1);
		// The restored command watch is steerable through its persisted mon_ id, so the fresh
		// runtime id really is bound in this generation's manager.
		const peeked = await generation.tools
			.get("bash_output")
			?.execute("peek-restored", { bash_id: "mon_WIREDCOMMAND00001", view: "screen" });
		expect(peeked?.isError, firstText(peeked)).toBeFalsy();
	});

	it("(h) a restored durable monitor whose manifest entry is muted is re-muted and counted as muted", async () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			manifestPath(),
			JSON.stringify({
				version: 1,
				sessionId,
				monitors: [
					{
						monitorId: "mon_WIREDMUTED0000001",
						sessionId,
						description: "muted durable command",
						runtimeKind: "command",
						durabilityClass: "restartable-command",
						command: "cat",
						cwd,
						createdAt: Date.now() - 1000,
						expiresAt: null,
						persistent: true,
						suspended: true,
						lastCheckpoint: null,
						deliveryPaused: true,
						fireWindow: { startMs: 1, count: 0 },
					},
				],
				backgroundSessions: [],
				updatedAt: Date.now(),
			}),
			"utf8",
		);

		const generation = await start("resume");

		expect(reminderContents(generation)).toContain(
			"<system-reminder>Terminal state after restart: 1 still muted.</system-reminder>",
		);
		expect(trackers.spawnCalls).toBe(1);
		// The mute was applied by the FRESH runtime id: bash_output reports the live monitor muted.
		const peeked = await generation.tools
			.get("bash_output")
			?.execute("peek-muted", { bash_id: "mon_WIREDMUTED0000001", view: "screen" });
		expect(peeked?.isError, firstText(peeked)).toBeFalsy();
		expect(firstText(peeked)).toContain("muted");
	});

	it("(i) production restore re-adopts a persisted fire window before the restored watch runs", async () => {
		const now = Date.now();
		const monitorId = "mon_WIREDFIREBUDGET01";
		const createdAt = now - 1000;
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			manifestPath(),
			JSON.stringify({
				version: 1,
				sessionId,
				monitors: [
					{
						monitorId,
						sessionId,
						description: "restored fire-budget watch",
						runtimeKind: "command",
						durabilityClass: "restartable-command",
						command: "cat",
						cwd,
						createdAt,
						expiresAt: createdAt + DURABLE_MONITOR_EXPIRY_MS,
						persistent: true,
						suspended: true,
						lastCheckpoint: null,
						deliveryPaused: false,
						fireWindow: { startMs: now, count: 150 },
					},
				],
				backgroundSessions: [],
				updatedAt: now,
			}),
			"utf8",
		);

		const generation = await start("resume");
		// Subscribe before feeding: the coalesced delivery that carries the echoed lines is the
		// signal that the PTY output was consumed, and whether that same delivery also carries
		// the auto-mute summary is exactly what the persisted fire window decides.
		const fireDelivery = nextMonitorNotification(generation, (content) => content.includes("restored-fire"));
		const fed = await generation.tools.get("bash_input")?.execute("feed-fire-budget", {
			bash_id: monitorId,
			input: `${Array.from({ length: 50 }, () => "restored-fire").join("\n")}\n`,
			submit: false,
		});
		expect(fed?.isError, firstText(fed)).toBeFalsy();

		// The restored command receives exactly 50 matching lines through the real PTY and monitor
		// runtime. With the persisted 150 fires, the 50th line reaches the 200-fire limit, so the
		// one coalesced delivery carries the lines AND the auto-mute summary together.
		const delivery = await fireDelivery;
		expect(delivery).toContain(FIRE_BUDGET_AUTO_MUTE_SUMMARY);
		expect(
			monitorEventContents(generation).filter((content) => content.includes(FIRE_BUDGET_AUTO_MUTE_SUMMARY)),
		).toHaveLength(1);

		const peeked = await generation.tools.get("bash_output")?.execute("peek-fire-budget", {
			bash_id: monitorId,
			view: "screen",
		});
		expect(peeked?.isError, firstText(peeked)).toBeFalsy();
		expect(firstText(peeked)).toContain("monitor muted");
	});

	it("(f) a non-reload shutdown flushes the manifest as suspended and releases the lease", async () => {
		const generation = await start("startup");
		await startMonitor(generation, "watch delta");
		await flushManifestWriters();
		expect(existsSync(manifestPath())).toBe(true);
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
