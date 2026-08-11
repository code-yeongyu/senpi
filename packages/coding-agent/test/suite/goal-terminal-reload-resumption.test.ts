import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import { GOAL_CONTINUATION_SCHEDULED_EVENT } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import { writeGoal } from "../../src/core/extensions/builtin/goal/store.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { cleanAssistantStop } from "./goal-monitor-test-harness.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type EventListener = (data: unknown) => void;
type ToolLike = ToolDefinition & {
	execute: (id: string, input: Record<string, unknown>) => Promise<unknown>;
};

interface Generation {
	readonly ctx: ExtensionContext;
	readonly emitted: Array<{ channel: string; data: unknown }>;
	readonly sentMessages: unknown[];
	readonly tools: Map<string, ToolLike>;
	emitLifecycle(eventType: string, payload: Record<string, unknown>): Promise<void>;
}

function activeGoal(id: string): Goal {
	return {
		id,
		threadId: `${id}-thread`,
		objective: "Keep moving while terminal work is live",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

function createGeneration(cwd: string, sessionId: string): Generation {
	const handlers = new Map<string, Handler[]>();
	const listeners = new Map<string, EventListener[]>();
	const tools = new Map<string, ToolLike>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const sentMessages: unknown[] = [];
	let activeTools: string[] = [];
	const events = {
		on(channel: string, listener: EventListener) {
			const registered = listeners.get(channel) ?? [];
			registered.push(listener);
			listeners.set(channel, registered);
			return () => {
				const index = registered.indexOf(listener);
				if (index >= 0) registered.splice(index, 1);
			};
		},
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const listener of listeners.get(channel) ?? []) listener(data);
		},
	};
	const pi = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
		on: (eventType: string, handler: Handler) => {
			const registered = handlers.get(eventType) ?? [];
			registered.push(handler);
			handlers.set(eventType, registered);
		},
		events,
		sendMessage: (message: unknown) => sentMessages.push(message),
		sendUserMessage: () => {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
	} as unknown as ExtensionAPI;

	// Match builtin/index.ts: terminal registers before goal, so lifecycle handlers run in that order.
	registerTerminalExtension(pi);
	goalExtension(pi);

	const ctx = {
		hasUI: true,
		cwd,
		mode: "tui",
		model: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: () => {}, select: async () => undefined, setStatus: () => {}, theme },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(cwd, "session.jsonl"),
			getSessionDir: () => cwd,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		emitted,
		sentMessages,
		tools,
		async emitLifecycle(eventType, payload) {
			for (const handler of handlers.get(eventType) ?? []) await handler(payload, ctx);
		},
	};
}

function scheduledEvents(generation: Generation): Array<Record<string, unknown>> {
	return generation.emitted
		.filter((event) => event.channel === GOAL_CONTINUATION_SCHEDULED_EVENT)
		.map((event) => event.data as Record<string, unknown>);
}

describe("goal + terminal resumption state across reload", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let current: Generation | undefined;

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-goal-terminal-reload-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		writeFileSync(join(cwd, ".senpi", "settings.json"), JSON.stringify({ terminal: { notify: "off" } }));
		current = undefined;
	});

	afterEach(async () => {
		if (current !== undefined) {
			await current.emitLifecycle("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	it("preserves both terminal snapshots when terminal rebinds before goal session_start", async () => {
		const sessionId = "goal-terminal-reload";
		const first = createGeneration(cwd, sessionId);
		current = first;
		await first.emitLifecycle("session_start", { type: "session_start", reason: "startup" });
		await first.tools.get("monitor")?.execute("monitor", {
			description: "reload monitor",
			command: "cat",
			persistent: true,
		});
		await first.tools.get("bash")?.execute("bash", {
			command: "cat",
			description: "reload background bash",
			run_in_background: true,
		});
		await writeGoal(
			{ baseDir: join(cwd, "extensions", "goal"), threadId: sessionId },
			activeGoal("goal-terminal-reload"),
		);

		await first.emitLifecycle("session_shutdown", { type: "session_shutdown", reason: "reload" });
		const second = createGeneration(cwd, sessionId);
		current = second;
		await second.emitLifecycle("session_start", { type: "session_start", reason: "reload" });
		await second.emitLifecycle("agent_end", {
			type: "agent_end",
			messages: [cleanAssistantStop()],
			aborted: false,
		});

		expect(second.sentMessages).toHaveLength(0);
		expect(scheduledEvents(second)).toContainEqual(
			expect.objectContaining({
				wakeSources: expect.objectContaining({
					"terminal-monitors": 1,
					"terminal-background-sessions": 1,
				}),
			}),
		);
	});
});
