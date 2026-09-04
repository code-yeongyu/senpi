/**
 * Real-surface terminal persistence QA: two fresh extension generations over one
 * on-disk session sidecar. No OS-level senpi process is spawned; PTYs and file
 * watchers are real.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import registerTerminalExtension from "../../src/core/extensions/builtin/terminal/index.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../src/core/extensions/types.ts";

const harness = vi.hoisted(() => ({
	/** Every TerminalManifestWriter the extension constructs, so the test can await its own flush. */
	writers: [] as Array<{ flush(): Promise<void> }>,
}));

vi.mock("../../src/core/extensions/builtin/terminal/terminal-manifest.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/core/extensions/builtin/terminal/terminal-manifest.ts")>();
	return {
		...original,
		TerminalManifestWriter: class extends original.TerminalManifestWriter {
			constructor(options: ConstructorParameters<typeof original.TerminalManifestWriter>[0]) {
				super(options);
				harness.writers.push(this);
			}
		},
	};
});

const SESSION_ID = "qa-persistent-monitor-restart";
type Tool = ToolDefinition<any, any, any>;
type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;

type Generation = {
	tools: Map<string, Tool>;
	handlers: Map<string, Handler[]>;
	messages: string[];
	context: ExtensionContext;
	api: ExtensionAPI;
	fire(event: string, payload: unknown): Promise<void>;
};

function generation(dir: string): Generation {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler[]>();
	const messages: string[] = [];
	const api = {
		cwd: dir,
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
		registerFlag: () => {},
		registerShortcut: () => {},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		registerMarkdownTransformer: () => {},
		registerFilesystemPolicy: () => {},
		registerMcpServer: () => {},
		registerRemovedToolHint: () => {},
		registerLazyToolActivator: () => {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		sendMessage: (message: { content?: unknown }) =>
			messages.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content)),
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getActiveTools: () => [],
		setActiveTools: () => {},
		events: { emit: () => {} },
		rpc: { emit: () => {} },
	} as unknown as ExtensionAPI;
	registerTerminalExtension(api);
	const context = {
		cwd: dir,
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { bg: (_: string, value: string) => value, fg: (_: string, value: string) => value },
		},
		model: { api: "openai-completions", provider: "qa", id: "qa-model" },
		sessionManager: {
			getSessionDir: () => dir,
			getSessionId: () => SESSION_ID,
			getSessionFile: () => join(dir, "session.jsonl"),
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	return {
		tools,
		handlers,
		messages,
		context,
		api,
		async fire(event, payload) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, context);
		},
	};
}

/**
 * Await the first model-channel message whose content satisfies `predicate`. The subscription
 * wraps the generation's sendMessage callback BEFORE the action that produces the message, so
 * the await resolves on the production delivery itself, never on a timed retry. The callback
 * is restored on first match, so later sends pass through untouched.
 */
function nextMessage(generation: Generation, predicate: (content: string) => boolean): Promise<string> {
	return new Promise((resolve) => {
		const channel = generation.api as unknown as {
			sendMessage: (message: { content?: unknown }, options?: unknown) => void;
		};
		const forward = channel.sendMessage.bind(channel);
		channel.sendMessage = (message, options) => {
			const content = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content);
			if (predicate(content)) {
				channel.sendMessage = forward;
				resolve(content);
			}
			return forward(message, options);
		};
	});
}

/** Await the manifest writer's own drain, so a manifest file read right after is deterministic. */
async function flushManifestWriters(): Promise<void> {
	await Promise.all(harness.writers.map((writer) => writer.flush()));
}

it("restores persistent monitors across two session generations and enforces the fire budget", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-qa-persistent-restart-"));
	const deploy = join(dir, "deploy.log");
	const service = join(dir, "svc.log");
	await writeFile(deploy, "before\n");
	await writeFile(service, "pre-restart\n");
	let a: Generation | undefined;
	let b: Generation | undefined;
	let backgroundId = "";
	let commandMonitorId = "";
	let originalRuntimeId = "";
	let restoredRuntimeId = "";
	const register = vi.spyOn(MonitorRegistry.prototype, "register");
	try {
		a = generation(dir);
		await a.fire("session_start", { type: "session_start", reason: "startup" });
		const monitor = a.tools.get("monitor");
		const bash = a.tools.get("bash");
		const shutdown = async (g: Generation, reason: "quit") =>
			g.fire("session_shutdown", { type: "session_shutdown", reason });
		if (!monitor || !bash) throw new Error("terminal tools were not registered");

		const backgroundResult = await bash.execute(
			"background",
			{ command: "sleep 30", description: "background bash", run_in_background: true },
			undefined,
			undefined,
			a.context,
		);
		const fileResult = await monitor.execute(
			"file",
			{ description: "deploy changes", path: deploy, event: "modify", persistent: true },
			undefined,
			undefined,
			a.context,
		);
		const commandResult = await monitor.execute(
			"command",
			{ description: "service log", command: `tail -n 0 -F ${service}`, persistent: true },
			undefined,
			undefined,
			a.context,
		);
		const ephemeralResult = await monitor.execute(
			"ephemeral deadline",
			{ description: "temporary wait", command: "sleep 30", timeout_ms: 60_000 },
			undefined,
			undefined,
			a.context,
		);
		commandMonitorId = String(commandResult.details?.monitor_id ?? "");
		originalRuntimeId = String(commandResult.details?.bash_id ?? "");
		backgroundId = String(backgroundResult.details?.bash_id ?? "");
		expect(fileResult.details?.monitor_id).toMatch(/^mon_/);
		expect(commandMonitorId).toMatch(/^mon_/);
		expect(originalRuntimeId).toMatch(/^bash_/);
		expect(ephemeralResult.details?.monitor_id).toMatch(/^mon_/);
		expect(backgroundId).toMatch(/^bash_/);
		await flushManifestWriters();
		expect(
			(await readFile(join(dir, "extensions", "terminal", `${SESSION_ID}.json`), "utf8")).includes(commandMonitorId),
		).toBe(true);
		await shutdown(a, "quit");
		await appendFile(deploy, "detached deploy\n");

		b = generation(dir);
		const detachedNotice = nextMessage(b, (content) => content.includes("changed while detached"));
		await b.fire("session_start", { type: "session_start", reason: "resume" });
		const digest = b.messages.filter((message) => message.includes("Terminal state after restart"));
		expect(digest).toHaveLength(1);
		expect(digest[0]).toContain("restored 2");
		expect(digest[0]).toContain("lost 2");
		const restored = b.tools.get("bash");
		const monitorB = b.tools.get("monitor");
		if (!monitorB || !restored) throw new Error("restored generation tools missing");
		const restoredRegistry = register.mock.instances.at(-1) as MonitorRegistry | undefined;
		const originalRegistry = register.mock.instances[0] as MonitorRegistry | undefined;
		if (!restoredRegistry || !originalRegistry) throw new Error("monitor registries were not captured");
		expect(restoredRegistry).not.toBe(originalRegistry);
		const restoredCommand = restoredRegistry.snapshot().find((entry) => entry.monitorId === commandMonitorId);
		expect(restoredCommand).toBeDefined();
		restoredRuntimeId = restoredCommand?.id ?? "";
		expect(restoredRuntimeId).not.toBe(commandMonitorId);
		expect(restoredRuntimeId).toMatch(/^bash_/);
		const fileNotice = await detachedNotice;
		expect(fileNotice).toContain("deploy.log");
		expect(b.messages.filter((message) => message.includes("changed while detached"))).toHaveLength(1);
		const manifestAfterRestore = JSON.parse(
			await readFile(join(dir, "extensions", "terminal", `${SESSION_ID}.json`), "utf8"),
		);
		const restoredEntry = manifestAfterRestore.monitors.find((entry: any) => entry.monitorId === commandMonitorId);
		expect(restoredEntry).toBeDefined();
		expect(restoredEntry.monitorId).toBe(commandMonitorId);
		expect(b.messages.filter((message) => message.includes("pre-restart"))).toHaveLength(0);
		const postRestartNotice = nextMessage(b, (content) => content.includes("post-restart"));
		await appendFile(service, "post-restart\n");
		await postRestartNotice;
		expect(b.messages.filter((message) => message.includes("post-restart"))).toHaveLength(1);

		const budgetNotice = nextMessage(b, (content) => content.includes("auto-muted: fire budget (200/24h) reached"));
		await appendFile(service, Array.from({ length: 300 }, (_, index) => `budget-${index}\n`).join(""));
		const budgetSummary = await budgetNotice;
		expect(
			b.messages.filter((message) => message.includes("auto-muted: fire budget (200/24h) reached")),
		).toHaveLength(1);
		expect(budgetSummary).toContain("service log");
		expect(restoredRegistry.snapshot()).toContainEqual(
			expect.objectContaining({
				id: restoredRuntimeId,
				monitorId: commandMonitorId,
				paused: true,
				fireWindow: expect.objectContaining({ count: 200 }),
			}),
		);
	} finally {
		if (b) {
			const kill = b.tools.get("kill_bash");
			if (kill && backgroundId)
				await kill.execute("cleanup-background", { bash_id: backgroundId }, undefined, undefined, b.context);
			if (kill && restoredRuntimeId)
				await kill.execute("cleanup-monitor", { bash_id: restoredRuntimeId }, undefined, undefined, b.context);
			await b.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
		if (a && !b) await a.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		register.mockRestore();
		await rm(dir, { recursive: true, force: true });
		expect(existsSync(dir)).toBe(false);
	}
});
