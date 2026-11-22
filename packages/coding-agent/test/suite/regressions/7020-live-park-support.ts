/**
 * One in-process socket host for the senpi#7020 regressions: the real router, registry, event writer and park record,
 * with every session a real `AgentSession` on the faux provider. A test parks a retained session on one host the way a
 * host ends it (idle sweep, unload, handoff drain, clean stop, or a kill that leaves its resident stamp) and reopens
 * the park record on a second host exactly as a successor does.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { runWithProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { CreateAgentSessionRuntimeResult } from "../../../src/core/agent-session-runtime.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { InlineExtension } from "../../../src/core/extensions/types.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { type HandoverParkedEntry, readHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-parked.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createHarness, type Harness } from "../harness.ts";

type AgentTool = NonNullable<Parameters<typeof createHarness>[0]>["tools"];

export interface ParkHostOptions {
	readonly extensions?: InlineExtension[];
	readonly tools?: AgentTool;
	readonly responses?: () => AssistantMessage[];
}

export type ParkHost = Awaited<ReturnType<typeof parkHost>>;

const cleanups: Array<() => Promise<void>> = [];

/** Disposes every host and scratch directory the test made; call from `afterEach`. */
export async function cleanupParkHosts(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export async function parkScratch(): Promise<{
	readonly dir: string;
	readonly daemonDir: string;
	sessionPath: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-7020-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return { dir, daemonDir: join(dir, "daemon"), sessionPath: join(dir, "lane.jsonl") };
}

export async function parkHost(dir: string, daemonDir: string, options: ParkHostOptions = {}) {
	let now = 0;
	const harnesses: Harness[] = [];
	const firstTurns = new Map<Harness, Promise<void>>();
	const lines: string[] = [];
	const lineWaiters = new Set<() => void>();
	const registry = new RpcSessionRegistry({
		agentDir: dir,
		now: () => now,
		createRuntime: async (runtime) => {
			await new ProjectTrustStore(runtime.agentDir).set(runtime.cwd, true);
			const h = await createHarness({
				cwd: runtime.cwd,
				sessionManager: runtime.sessionManager,
				...(runtime.sessionStartEvent ? { sessionStartEvent: runtime.sessionStartEvent } : {}),
				...(options.extensions ? { extensionFactories: options.extensions } : {}),
				...(options.tools ? { tools: options.tools } : {}),
			});
			harnesses.push(h);
			firstTurns.set(h, firstTurnSettled(h.session));
			h.setResponses(
				options.responses?.() ?? Array.from({ length: 10 }, () => fauxAssistantMessage([fauxText("done")])),
			);
			await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
			return {
				session: h.session,
				services: { cwd: runtime.cwd, agentDir: runtime.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	});
	const writer = new SessionEventWriter((line) => {
		lines.push(line);
		for (const waiter of lineWaiters) waiter();
	});
	const connections = new Set<string>();
	const connect = (connection: string): string => {
		if (connections.has(connection)) return connection;
		connections.add(connection);
		writer.registerConnection(connection, {
			writeRaw: (line) => {
				lines.push(line);
				for (const waiter of lineWaiters) waiter();
			},
			waitForBackpressure: async () => {},
		});
		return connection;
	};
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: dir },
		async () => ({ handle: async () => {}, dispose: async () => {}, cancelPendingExtensionUiRequests: () => {} }),
		{},
		{ handoverParkedDir: daemonDir, idleEvictionMs: 1, now: () => now },
	);
	let disposed = false;
	const dispose = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		await router.dispose();
		for (const h of harnesses.splice(0).reverse()) h.cleanup();
	};
	cleanups.push(dispose);
	return {
		router,
		registry,
		dispose,
		/** The harness of the session this host opened last. */
		get harness(): Harness {
			const h = harnesses.at(-1);
			if (h === undefined) throw new Error("this host opened no session");
			return h;
		},
		get session(): AgentSession {
			return this.harness.session;
		},
		/**
		 * Runs `act` inside the last opened session's provider scope, where the host runs that session's work: its faux
		 * provider is registered there, as a real provider registration is per session.
		 */
		inScope<T>(act: () => T): T {
			const session = this.session;
			const entry = registry
				.list()
				.map((row) => registry.peek(row.sessionId))
				.find((e) => e?.runtime?.session === session);
			if (entry === undefined) throw new Error("the session is not open on this host");
			return runWithProviderScope(entry.scope, act);
		},
		/** Settles once the last opened session's first turn, from the moment it was built, has gone idle. */
		get firstTurn(): Promise<void> {
			const turn = firstTurns.get(this.harness);
			if (turn === undefined) throw new Error("this host opened no session");
			return turn;
		},
		/** Opens the retained session for the `client` connection, as a socket client does. */
		async open(sessionPath: string): Promise<string> {
			await writer.withConnection(connect("client"), () =>
				router.handle({ type: "open_session", sessionPath, cwd: dir, retain_on_disconnect: true }),
			);
			const row = registry.list().at(-1);
			if (row === undefined) throw new Error("the open registered no session");
			return row.sessionId;
		},
		async send(command: RpcCommand, connection = "client"): Promise<unknown> {
			return writer.withConnection(connect(connection), () => router.handle(command));
		},
		/** The client's socket closes: the retained session stays open with no attachment. */
		async detach(connection = "client"): Promise<void> {
			writer.unregisterConnection(connection);
			connections.delete(connection);
			await router.releaseConnection(connection);
		},
		/** Resolves once the host wrote a record line containing `text`. */
		waitForLine(text: string): Promise<void> {
			if (lines.some((line) => line.includes(text))) return Promise.resolve();
			return new Promise((resolve) => {
				const waiter = (): void => {
					if (!lines.some((line) => line.includes(text))) return;
					lineWaiters.delete(waiter);
					resolve();
				};
				lineWaiters.add(waiter);
			});
		},
		/** The idle sweep parks the retained session (`session_parked { reason: "idle" }`). */
		async idleSweep(): Promise<void> {
			now = 10_000;
			const parked = this.waitForLine('"session_parked"');
			router.sweepIdleSessions();
			await parked;
		},
	};
}

/** Settles once `session` has started a turn and gone idle again. */
export function firstTurnSettled(session: AgentSession): Promise<void> {
	return new Promise((resolve) => {
		let started = false;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") started = true;
			if (!started || event.type !== "agent_idle") return;
			unsubscribe();
			resolve();
		});
	});
}

/** The park record entry for `sessionPath`, as the next host reads it. */
export async function parkedEntry(daemonDir: string, sessionPath: string): Promise<HandoverParkedEntry> {
	const entry = (await readHandoverParkedSessions(daemonDir)).find(
		(candidate) => candidate.sessionPath === sessionPath,
	);
	if (entry === undefined) throw new Error(`no park record for ${sessionPath}`);
	return entry;
}

/** The successor's reopen of `entry`: a fresh host on the same agent dir and daemon dir. */
export async function reopenOnSuccessor(
	dir: string,
	daemonDir: string,
	entry: HandoverParkedEntry,
	options: ParkHostOptions = {},
): Promise<ParkHost> {
	const successor = await parkHost(dir, daemonDir, options);
	const failure = await successor.router.reopenParked(entry);
	if (failure !== undefined) throw new Error(`the successor's reopen failed: ${JSON.stringify(failure)}`);
	return successor;
}

/** `promise`, or a rejection naming `what` once `ms` pass first: a turn that never comes fails the test, not the run. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The park record's `live` fact, read without depending on the entry type declaring it. */
export function liveOf(entry: HandoverParkedEntry): unknown {
	return (entry as { readonly live?: unknown }).live;
}

/** Engine turns already in the file: more than one resume window's worth (8). */
export function appendHistoricalEngineStarts(h: Harness, count = 9): void {
	for (let i = 0; i < count; i++)
		h.sessionManager.appendCustomEntry("engine-turn-start", { customType: "senpi-monitor:event" });
}
