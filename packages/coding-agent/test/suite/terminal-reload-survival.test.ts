import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { FileMonitorWatch } from "../../src/core/extensions/builtin/terminal/file-monitor-runtime.ts";
import type { MonitorEvent } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import {
	type TerminalEventSinks,
	TerminalSessionBundle,
} from "../../src/core/extensions/builtin/terminal/session-bundle.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { FakeWatcher } from "./native-file-monitor-harness.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface ToolResultLike {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

interface ToolLike {
	name: string;
	execute: (id: string, input: Record<string, unknown>) => Promise<ToolResultLike>;
}

/**
 * One extension-runner generation. A real reload replaces the runner and re-runs
 * every extension factory, so each generation gets its own fake pi, tools, and
 * notification stream — exactly the seam `AgentSession.reload()` exercises.
 */
interface FakeRunner {
	pi: ExtensionAPI;
	tools: Map<string, ToolLike>;
	sentMessages: string[];
	setStatus: ReturnType<typeof vi.fn>;
	emit(eventType: string, payload: Record<string, unknown>, ctx: ExtensionContext): Promise<void>;
	waitForMessage(predicate: (content: string) => boolean, label: string): Promise<string>;
}

function monitorSinks(events: MonitorEvent[]): TerminalEventSinks {
	return {
		onMonitorEvent: (event) => events.push(event),
		onMonitorState: () => {},
		onBackgroundState: () => {},
		onBackgroundExit: () => {},
	};
}

function createRunner(): FakeRunner {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolLike>();
	const sentMessages: string[] = [];
	const listeners = new Set<(content: string) => void>();
	let activeTools: string[] = [];
	const pi = Object.assign({} as ExtensionAPI, {
		registerTool: (tool: ToolLike) => {
			tools.set(tool.name, tool);
		},
		on: (eventType: string, handler: Handler) => {
			const existing = handlers.get(eventType) ?? [];
			existing.push(handler);
			handlers.set(eventType, existing);
		},
		sendMessage: (message: { content: string }) => {
			sentMessages.push(message.content);
			for (const listener of listeners) listener(message.content);
		},
		sendUserMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	});
	return {
		pi,
		tools,
		sentMessages,
		setStatus: vi.fn(),
		async emit(eventType, payload, ctx) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
		waitForMessage(predicate, label) {
			return new Promise<string>((resolve, reject) => {
				const existing = sentMessages.find(predicate);
				if (existing !== undefined) {
					resolve(existing);
					return;
				}
				const timeout = setTimeout(() => {
					listeners.delete(listener);
					reject(new Error(`Timed out waiting for ${label}`));
				}, 8000);
				const listener = (content: string) => {
					if (!predicate(content)) return;
					clearTimeout(timeout);
					listeners.delete(listener);
					resolve(content);
				};
				listeners.add(listener);
			});
		},
	};
}

function makeCtx(runner: FakeRunner, cwd: string, sessionId: string): ExtensionContext {
	return Object.assign({} as ExtensionContext, {
		cwd,
		mode: "tui",
		model: { id: "test-model", api: "openai-completions" },
		ui: { setStatus: runner.setStatus, notify: () => {}, theme },
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
	});
}

function firstText(result: ToolResultLike): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

function extractBashId(text: string): string {
	const match = /ID: (bash_\d+)/.exec(text);
	if (!match?.[1]) throw new Error(`No bash id in tool result: ${text}`);
	return match[1];
}

function extractWatchId(text: string): string {
	const match = /ID: (watch_\d+)/.exec(text);
	if (!match?.[1]) throw new Error(`No watch id in tool result: ${text}`);
	return match[1];
}

function waitForFile(path: string, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const watcher = watch(dirname(path), settleIfPresent);
		const timeout = setTimeout(() => {
			watcher.close();
			reject(new Error(`Timed out waiting for ${label}`));
		}, 8000);
		function settleIfPresent(): void {
			if (!existsSync(path)) return;
			clearTimeout(timeout);
			watcher.close();
			resolve();
		}
		settleIfPresent();
	});
}

describe("terminal extension — background state survives reload", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionId: string;
	let sessionCounter = 0;
	/** Every live generation gets a quit shutdown in afterEach so no PTY leaks across tests. */
	let liveGenerations: Array<{ runner: FakeRunner; ctx: ExtensionContext }> = [];

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-reload-survival-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		writeFileSync(
			join(cwd, ".senpi", "settings.json"),
			JSON.stringify({ terminal: { monitorCoalesceWindowMs: 25, monitorRateLimitMs: 25, notify: "wake" } }),
		);
		sessionId = `reload-survival-${++sessionCounter}`;
		liveGenerations = [];
	});

	afterEach(async () => {
		for (const generation of liveGenerations) {
			await generation.runner.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, generation.ctx);
		}
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	async function startGeneration(reason: string): Promise<{ runner: FakeRunner; ctx: ExtensionContext }> {
		const runner = createRunner();
		registerTerminalExtension(runner.pi);
		const ctx = makeCtx(runner, cwd, sessionId);
		await runner.emit("session_start", { type: "session_start", reason }, ctx);
		liveGenerations.push({ runner, ctx });
		return { runner, ctx };
	}

	/** Mirrors AgentSession.reload(): shutdown(reason reload) on the old runner, fresh factory + session_start(reason reload) on the new one. */
	async function reloadInto(previous: { runner: FakeRunner; ctx: ExtensionContext }): Promise<{
		runner: FakeRunner;
		ctx: ExtensionContext;
	}> {
		await previous.runner.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, previous.ctx);
		return await startGeneration("reload");
	}

	it("keeps a monitor watching and re-publishes its footer status across reload (C1)", async () => {
		const gen1 = await startGeneration("startup");
		const trigger = join(tmp, "fire-c1");
		const ready = join(tmp, "ready-c1");
		const waitScript = join(tmp, "wait-for-trigger.mjs");
		writeFileSync(
			waitScript,
			[
				'import { existsSync, watch, writeFileSync } from "node:fs";',
				'import { dirname } from "node:path";',
				"const [trigger, ready] = process.argv.slice(2);",
				"const complete = () => {",
				"\tif (!existsSync(trigger)) return;",
				"\twatcher.close();",
				'\tprocess.stdout.write("event-after-reload\\n");',
				"};",
				"const watcher = watch(dirname(trigger), complete);",
				'writeFileSync(ready, "ready");',
				"complete();",
			].join("\n"),
		);
		const workerReady = waitForFile(ready, "reload-survival worker readiness");
		const created = await gen1.runner.tools.get("monitor")?.execute("c1", {
			description: "reload survivor watch",
			command: `${JSON.stringify(process.execPath)} ${JSON.stringify(waitScript)} ${JSON.stringify(trigger)} ${JSON.stringify(ready)}`,
			persistent: true,
		});
		expect(created?.isError).toBeFalsy();
		extractBashId(firstText(created ?? { content: [] }));
		await workerReady;

		const gen2 = await reloadInto(gen1);

		expect(gen2.runner.setStatus).toHaveBeenCalledWith("monitors", expect.stringContaining("reload survivor watch"));

		const delivered = gen2.runner.waitForMessage(
			(content) => content.includes("event-after-reload"),
			"post-reload monitor line on the new runner",
		);
		writeFileSync(trigger, "go\n");
		expect(await delivered).toContain("reload survivor watch");
	});

	it("keeps a background session alive and addressable by its original id across reload (C2)", async () => {
		const gen1 = await startGeneration("startup");
		const created = await gen1.runner.tools.get("bash")?.execute("c2", {
			command: "sh -c 'echo alive-before-reload; cat'",
			run_in_background: true,
		});
		expect(created?.isError).toBeFalsy();
		const bashId = extractBashId(firstText(created ?? { content: [] }));

		const gen2 = await reloadInto(gen1);

		const peeked = await gen2.runner.tools
			.get("bash_output")
			?.execute("c2-peek", { bash_id: bashId, view: "screen" });
		expect(peeked?.isError).toBeFalsy();
		const peekedText = firstText(peeked ?? { content: [] });
		expect(peekedText).toContain("status: running");
		expect(peekedText).toContain("alive-before-reload");
	});

	it("keeps a native watch addressable across reload and cancels it from the new generation", async () => {
		const gen1 = await startGeneration("startup");
		const created = await gen1.runner.tools.get("monitor")?.execute("native-reload", {
			description: "native reload survivor",
			path: join(tmp, "native-reload.json"),
			event: "create",
		});
		expect(created?.isError).toBeFalsy();
		const watchId = extractWatchId(firstText(created ?? { content: [] }));

		const gen2 = await reloadInto(gen1);
		expect(gen2.runner.setStatus).toHaveBeenCalledWith("monitors", expect.stringContaining("native reload survivor"));

		const killed = await gen2.runner.tools.get("kill_bash")?.execute("native-reload-kill", { bash_id: watchId });
		expect(killed?.isError).toBeFalsy();
		expect(firstText(killed ?? { content: [] })).toContain(`Killed ${watchId}`);
		expect(gen2.runner.setStatus).toHaveBeenCalledWith("monitors", undefined);
	});

	it("delivers native file events through the rebound sinks after reload", async () => {
		const target = join(realpathSync(tmp), "native-delivery.json");
		let watcher: FakeWatcher | undefined;
		const fileMonitor: FileMonitorWatch = (_path, _options, listener) => {
			watcher = new FakeWatcher(listener);
			return watcher;
		};
		const bundle = new TerminalSessionBundle({ fileMonitor: { watch: fileMonitor } });
		const oldEvents: MonitorEvent[] = [];
		const reboundEvents: MonitorEvent[] = [];
		bundle.bind(monitorSinks(oldEvents));
		await bundle.monitors.registerFile({
			description: "reload delivery",
			path: target,
			event: "create",
			timeoutMs: 5000,
		});

		try {
			bundle.park();
			bundle.bind(monitorSinks(reboundEvents));
			writeFileSync(target, "{}");
			watcher?.emit("native-delivery.json");
			await Promise.resolve();

			expect(oldEvents).toEqual([]);
			expect(reboundEvents).toEqual([
				expect.objectContaining({ type: "line", line: `created ${target}` }),
				expect.objectContaining({ type: "summary", summary: expect.stringContaining("completed") }),
			]);
		} finally {
			await bundle.teardown();
		}
	});

	it("never evicts parked completion summaries behind line events", async () => {
		const canonicalTmp = realpathSync(tmp);
		const watchers: FakeWatcher[] = [];
		const fileMonitor: FileMonitorWatch = (_path, _options, listener) => {
			const watcher = new FakeWatcher(listener);
			watchers.push(watcher);
			return watcher;
		};
		const bundle = new TerminalSessionBundle({ maxSessions: 128, fileMonitor: { watch: fileMonitor } });
		const reboundEvents: MonitorEvent[] = [];
		bundle.bind(monitorSinks([]));

		try {
			for (let index = 0; index < 101; index += 1) {
				await bundle.monitors.registerFile({
					description: `parked file ${index}`,
					path: join(canonicalTmp, `parked-${index}.json`),
					event: "create",
					timeoutMs: 5000,
				});
			}
			bundle.park();
			for (let index = 0; index < watchers.length; index += 1) {
				writeFileSync(join(canonicalTmp, `parked-${index}.json`), "{}");
				watchers[index]?.emit(`parked-${index}.json`);
				await Promise.resolve();
			}
			expect(bundle.monitors.snapshot()).toEqual([]);

			bundle.bind(monitorSinks(reboundEvents));
			expect(reboundEvents.filter((event) => event.type === "summary")).toHaveLength(101);
		} finally {
			await bundle.teardown();
		}
	});

	it("retains every parked background exit up to configured capacity", async () => {
		const bundle = new TerminalSessionBundle({ maxSessions: 64 });
		const exits: string[] = [];
		bundle.park();

		for (let index = 0; index < 40; index += 1) {
			const id = `bash_${index + 1}`;
			const runtime = {} as TerminalRuntimeSession;
			bundle.notifyBackgroundStart(id, `background ${index}`);
			bundle.notifyBackgroundExit(id, runtime);
		}
		bundle.bind({
			...monitorSinks([]),
			onBackgroundExit: (id) => exits.push(id),
		});

		try {
			expect(exits).toHaveLength(40);
		} finally {
			await bundle.teardown();
		}
	});

	it("routes a post-reload background completion notification through the new runner (C3)", async () => {
		const gen1 = await startGeneration("startup");
		const trigger = join(tmp, "fire-c3");
		const created = await gen1.runner.tools.get("bash")?.execute("c3", {
			command: `sh -c 'while [ ! -e "${trigger}" ]; do sleep 0.05; done; echo finishing-now'`,
			run_in_background: true,
		});
		const bashId = extractBashId(firstText(created ?? { content: [] }));

		const gen2 = await reloadInto(gen1);

		const delivered = gen2.runner.waitForMessage(
			(content) => content.includes(`session ${bashId} finished`),
			"post-reload completion notification on the new runner",
		);
		writeFileSync(trigger, "");
		expect(await delivered).toContain("finishing-now");
	});

	it("still tears everything down on a non-reload shutdown (C4 pin)", async () => {
		const gen1 = await startGeneration("startup");
		const pidFile = join(tmp, "pid-c4");
		await gen1.runner.tools.get("bash")?.execute("c4", {
			command: `sh -c 'echo $$ > "${pidFile}"; cat'`,
			run_in_background: true,
		});
		await expect.poll(() => existsSync(pidFile), { timeout: 3000 }).toBe(true);
		const monitorResult = await gen1.runner.tools.get("monitor")?.execute("c4-mon", {
			description: "quit teardown watch",
			command: "cat",
			persistent: true,
		});
		expect(monitorResult?.isError).toBeFalsy();
		expect(gen1.runner.setStatus).toHaveBeenCalledWith("monitors", expect.stringContaining("quit teardown watch"));

		await gen1.runner.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, gen1.ctx);
		liveGenerations = [];

		expect(gen1.runner.setStatus).toHaveBeenCalledWith("monitors", undefined);
		const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
		expect(Number.isFinite(pid)).toBe(true);
		await expect
			.poll(
				() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				},
				{ timeout: 5000 },
			)
			.toBe(false);
	});
});
