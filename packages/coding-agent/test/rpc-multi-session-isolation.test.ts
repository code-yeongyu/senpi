import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import configReloadExtension from "../src/core/extensions/builtin/config-reload/index.ts";
import type {
	WatchClock,
	WatchEventListener,
	WatchEventSource,
} from "../src/core/extensions/builtin/config-reload/watch-engine.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../src/core/extensions/types.ts";
import type { RpcSessionBinding } from "../src/modes/rpc/session-binding.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const roots: string[] = [];
const reloadHarnesses: Harness[] = [];

afterEach(() => {
	for (const harness of reloadHarnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "senpi-rpc-isolation-"));
	roots.push(value);
	return value;
}

function provider(api: string, owner: string) {
	return {
		api,
		stream: () => {
			throw new Error(`provider ${owner} is a test sentinel`);
		},
		streamSimple: () => {
			throw new Error(`provider ${owner} is a test sentinel`);
		},
	};
}

/** Invokes the wrapped provider so its per-session sentinel becomes observable. */
function resolvedProviderOwner(api: string): string {
	const resolved = getApiProvider(api);
	if (!resolved) throw new Error(`missing scoped provider ${api}`);
	try {
		resolved.stream({ api } as never, {} as never);
	} catch (error) {
		const match = /^provider (.+) is a test sentinel$/.exec(error instanceof Error ? error.message : String(error));
		if (match?.[1]) return match[1];
		throw error;
	}
	throw new Error(`provider ${api} did not produce its sentinel`);
}

type RegisteredWatchProbe = {
	readonly subscribe: WatchEventSource;
	emit(path: string, filename: string): void;
};

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

type PromptGate = {
	readonly entered: Deferred;
	readonly release: Deferred;
};

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function registeredWatchProbe(): RegisteredWatchProbe {
	const listeners = new Map<string, Set<WatchEventListener>>();
	return {
		subscribe: (path, listener) => {
			const registered = listeners.get(path) ?? new Set<WatchEventListener>();
			registered.add(listener);
			listeners.set(path, registered);
			return () => registered.delete(listener);
		},
		emit: (path, filename) => {
			for (const listener of listeners.get(path) ?? []) listener("change", filename);
		},
	};
}

function manuallyFlushedWatchClock(): WatchClock & { flush(): void } {
	const callbacks = new Set<() => void>();
	return {
		setTimeout: (callback) => {
			callbacks.add(callback);
			return callback as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (timer) => callbacks.delete(timer as unknown as () => void),
		flush: () => {
			while (callbacks.size > 0) {
				const scheduled = [...callbacks];
				callbacks.clear();
				for (const callback of scheduled) callback();
			}
		},
	};
}

function records(chunks: readonly string[]): Array<Record<string, unknown>> {
	return chunks
		.flatMap((chunk) => chunk.split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * This fixture sends JSON command envelopes through the production multi-session
 * command router. Session construction, scope ownership, output tagging, close
 * sealing, and registry removal are all the same objects used by the stdio host.
 * The minimal runtime exists only because an LLM transport is not relevant to
 * provider-scope routing; its prompt binding resolves the provider inside the
 * scope captured by the production registry.
 */
function hostFixture() {
	const cwd = root();
	const output: string[] = [];
	const resolutions = new Map<string, string>();
	const promptGates = new Map<string, PromptGate>();
	const streaming = new Map<string, boolean>();
	let nextOwner = 0;
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const owner = `owner-${++nextOwner}`;
		const durableSessionId = options.sessionManager.getSessionId();
		streaming.set(durableSessionId, false);
		registerApiProvider(provider("rpc-isolation-provider", owner));
		return {
			session: {
				sessionManager: options.sessionManager,
				model: undefined,
				thinkingLevel: "off",
				get isStreaming() {
					return streaming.get(durableSessionId) ?? false;
				},
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionFile: options.sessionManager.getSessionFile(),
				sessionId: options.sessionManager.getSessionId(),
				sessionName: undefined,
				autoCompactionEnabled: false,
				messages: [],
				pendingMessageCount: 0,
				extensionRunner: { hasHandlers: () => false, emit: async () => {} },
				abort: async () => {},
				abortBash: () => {},
				waitForIdle: async () => {},
				dispose: () => {},
			},
			services: { cwd: options.cwd, agentDir: options.agentDir },
			diagnostics: [],
		} as unknown as CreateAgentSessionRuntimeResult;
	};
	const registry = new RpcSessionRegistry({ agentDir: cwd, createRuntime });
	const writer = new SessionEventWriter(
		(chunk) => output.push(chunk),
		(flush) => flush(),
	);
	const router = new SessionCommandRouter(registry, writer, { cwd }, async (sessionId, entry, eventWriter) => {
		const binding: RpcSessionBinding = {
			handle: async (command: { type?: string }) => {
				if (command.type !== "prompt") return;
				const gate = promptGates.get(sessionId);
				const durableSessionId = entry.runtime!.session.sessionId;
				if (gate) {
					streaming.set(durableSessionId, true);
					eventWriter.enqueue(sessionId, { type: "message_update", text: `stream:${sessionId}` });
					gate.entered.resolve();
					await gate.release.promise;
				}
				try {
					const owner = runWithProviderScope(entry.scope, () => resolvedProviderOwner("rpc-isolation-provider"));
					resolutions.set(sessionId, owner);
					if (!gate) eventWriter.enqueue(sessionId, { type: "message_update", text: `stream:${sessionId}` });
					eventWriter.enqueue(sessionId, { type: "agent_end", text: `done:${sessionId}` });
				} finally {
					if (gate) streaming.set(durableSessionId, false);
				}
			},
			dispose: async () => {},
		};
		return binding;
	});
	const send = async (command: Parameters<SessionCommandRouter["handle"]>[0]) => {
		const response = await router.handle(JSON.parse(JSON.stringify(command)));
		if (response) output.push(`${JSON.stringify(response)}\n`);
	};
	const holdPrompt = (sessionId: string) => {
		const gate: PromptGate = { entered: deferred(), release: deferred() };
		promptGates.set(sessionId, gate);
		return gate;
	};
	const isStreaming = (sessionId: string) => {
		const entry = registry.getForCommand(sessionId, "prompt");
		return entry.runtime!.session.isStreaming;
	};
	return { cwd, output, registry, resolutions, router, send, holdPrompt, isStreaming };
}

function openedHandle(output: readonly string[], id: string): string {
	const record = records(output).find((line) => line.id === id && line.command === "open_session");
	if (typeof record?.sessionId !== "string") throw new Error(`open_session ${id} did not return a routing handle`);
	return record.sessionId;
}

describe("multi-session RPC isolation battery", () => {
	it("routes concurrent scoped-provider prompts through their owning host sessions without cross-tags", async () => {
		const host = hostFixture();
		await host.send({ id: "open-a", type: "open_session", cwd: host.cwd, sessionPath: join(host.cwd, "a.jsonl") });
		await host.send({ id: "open-b", type: "open_session", cwd: host.cwd, sessionPath: join(host.cwd, "b.jsonl") });
		const alpha = openedHandle(host.output, "open-a");
		const bravo = openedHandle(host.output, "open-b");

		await Promise.all([
			host.send({ id: "prompt-a", type: "prompt", sessionId: alpha, message: "alpha" }),
			host.send({ id: "prompt-b", type: "prompt", sessionId: bravo, message: "bravo" }),
		]);

		expect(host.resolutions.get(alpha)).toBe("owner-1");
		expect(host.resolutions.get(bravo)).toBe("owner-2");
		const streamed = records(host.output).filter(
			(line) => line.type === "message_update" || line.type === "agent_end",
		);
		expect(streamed.filter((line) => line.sessionId === alpha)).toHaveLength(2);
		expect(streamed.filter((line) => line.sessionId === bravo)).toHaveLength(2);
		expect(streamed.every((line) => line.sessionId === alpha || line.sessionId === bravo)).toBe(true);
	});

	it("keeps B's provider overlay alive when A closes through close_session", async () => {
		const host = hostFixture();
		await host.send({ id: "open-a", type: "open_session", cwd: host.cwd, sessionPath: join(host.cwd, "a.jsonl") });
		await host.send({ id: "open-b", type: "open_session", cwd: host.cwd, sessionPath: join(host.cwd, "b.jsonl") });
		const alpha = openedHandle(host.output, "open-a");
		const bravo = openedHandle(host.output, "open-b");

		await host.send({ id: "close-a", type: "close_session", sessionId: alpha });
		await host.send({ id: "prompt-b", type: "prompt", sessionId: bravo, message: "B survives" });

		expect(host.resolutions.get(bravo)).toBe("owner-2");
		expect(records(host.output).find((line) => line.id === "close-a")).toMatchObject({
			sessionId: alpha,
			success: true,
		});
	});

	it("runs the registered config-reload watcher callback through AgentSession.reload while B remains mid-stream", async () => {
		const host = hostFixture();
		await host.send({ id: "open-a", type: "open_session", cwd: host.cwd, sessionPath: join(host.cwd, "a.jsonl") });
		await host.send({ id: "open-b", type: "open_session", cwd: host.cwd, sessionPath: join(host.cwd, "b.jsonl") });
		const alpha = openedHandle(host.output, "open-a");
		const bravo = openedHandle(host.output, "open-b");
		const alphaEntry = host.registry.getForCommand(alpha, "prompt");
		const bravoEntry = host.registry.getForCommand(bravo, "prompt");
		const api = "rpc-reload-isolation-provider";
		runWithProviderScope(alphaEntry.scope, () => registerApiProvider(provider(api, "reload-A")));
		runWithProviderScope(bravoEntry.scope, () => registerApiProvider(provider(api, "reload-B")));
		expect(host.registry.list().find((entry) => entry.sessionId === bravo)?.status).toBe("open");

		// This is a real AgentSession. The callback below reaches its production
		// reload() implementation, including agent-session.ts resetApiProviders().
		const harness = await runWithProviderScope(alphaEntry.scope, () => createHarness());
		reloadHarnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, '{"theme":"dark"}\n');

		const watches = registeredWatchProbe();
		const clock = manuallyFlushedWatchClock();
		const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
		const extensionApi = {
			events: createEventBus(),
			on: (event: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
		} as unknown as ExtensionAPI;
		runWithProviderScope(alphaEntry.scope, () =>
			configReloadExtension(extensionApi, { agentDir, subscribe: watches.subscribe, clock }),
		);
		const reloadStarted = Promise.withResolvers<void>();
		let reloadCount = 0;
		const context = {
			cwd: harness.tempDir,
			mode: "tui",
			sessionManager: alphaEntry.runtime!.session.sessionManager,
			ui: { notify: () => {} },
			isIdle: () => true,
			hasPendingMessages: () => false,
			isProjectTrusted: () => true,
			isCompacting: () => false,
			requestReload: async () => {
				reloadCount += 1;
				await harness.session.reload();
				reloadStarted.resolve();
			},
		} as unknown as ExtensionContext;
		const sessionStart = handlers.get("session_start")?.[0];
		if (!sessionStart) throw new Error("config-reload extension did not register session_start");
		await runWithProviderScope(alphaEntry.scope, () =>
			sessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, context),
		);

		// Subscribe before triggering B's prompt, then hold its handler after the
		// first streamed update. This makes the reload overlap a live B turn rather
		// than a completed prompt from an idle session.
		const bTurnGate = host.holdPrompt(bravo);
		const bTurn = host.send({
			id: "prompt-b-during-a-reload",
			type: "prompt",
			sessionId: bravo,
			message: "B streams through A reload",
		});
		await bTurnGate.entered.promise;
		expect(host.isStreaming(bravo)).toBe(true);
		expect(host.resolutions.get(bravo)).toBeUndefined();

		writeFileSync(settingsPath, '{"theme":"light"}\n');
		// fs.watch delivery is nondeterministic in a parallel test run, so invoke
		// the callback registered by the production config-reload extension directly.
		watches.emit(agentDir, "settings.json");
		clock.flush();
		await reloadStarted.promise;

		// The production reload has reset only A's overlay while B's handler is
		// still blocked mid-turn. The B sentinel is the discriminating oracle.
		expect(reloadCount).toBe(1);
		expect(host.isStreaming(bravo)).toBe(true);
		expect(runWithProviderScope(alphaEntry.scope, () => getApiProvider(api))).toBeUndefined();
		expect(runWithProviderScope(bravoEntry.scope, () => resolvedProviderOwner(api))).toBe("reload-B");

		bTurnGate.release.resolve();
		await bTurn;
		expect(host.isStreaming(bravo)).toBe(false);
		expect(host.resolutions.get(bravo)).toBe("owner-2");
		expect(records(host.output).filter((line) => line.sessionId === bravo && line.type === "agent_end")).toHaveLength(
			1,
		);
	});

	it("opens eight host sessions and closes all of them without registry leakage", async () => {
		const host = hostFixture();
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				host.send({
					id: `open-${index}`,
					type: "open_session",
					cwd: host.cwd,
					sessionPath: join(host.cwd, `${index}.jsonl`),
				}),
			),
		);
		const handles = Array.from({ length: 8 }, (_, index) => openedHandle(host.output, `open-${index}`));
		expect(host.registry.list()).toHaveLength(8);
		await Promise.all(
			handles.map((sessionId, index) => host.send({ id: `close-${index}`, type: "close_session", sessionId })),
		);
		expect(host.registry.list()).toEqual([]);
	});
});
