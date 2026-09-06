import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { isSessionBusySnapshot } from "../src/core/session-activity.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import type { MultiSessionHostOptions } from "../src/modes/rpc/multi-session-host.ts";
import * as multiSessionHost from "../src/modes/rpc/multi-session-host.ts";
import {
	type RpcBindingFactory,
	type RpcSessionIdlePolicy,
	SessionCommandRouter,
} from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { type RpcSessionLaunchProfile, RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";

/**
 * Occupancy contract for the shared multi-session RPC host:
 *
 * - (4.1) sessions idle beyond a configurable window are evicted through the
 *   normal close path (never one with an active turn), and a host whose
 *   registry stays empty exits instead of residenting forever;
 * - (4.2) concurrent open_session is capped.
 *
 * Time is driven exclusively by vitest fake timers plus the injected `now`
 * clocks, so nothing here depends on wall-clock sleeps.
 */

const IDLE_WINDOW_MS = 1_000;

/** Mirrors the real session-owned activity sources the sweep must respect. */
interface FakeRuntimeState {
	isStreaming: boolean;
	isBashRunning: boolean;
	isCompacting: boolean;
	hasSessionWork: boolean;
	/** Stands in for a background terminal job (published wake source). */
	hasBackgroundJob: boolean;
	runtimeDisposals: number;
}

function createRuntimeFactory(): {
	createRuntime: CreateAgentSessionRuntimeFactory;
	states: FakeRuntimeState[];
} {
	const states: FakeRuntimeState[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		new ProjectTrustStore(options.agentDir).set(options.cwd, true);
		const state: FakeRuntimeState = {
			isStreaming: false,
			isBashRunning: false,
			isCompacting: false,
			hasSessionWork: false,
			hasBackgroundJob: false,
			runtimeDisposals: 0,
		};
		states.push(state);
		return {
			session: {
				sessionManager: options.sessionManager,
				agentDir: options.agentDir,
				isFastModeActive: () => false,
				getContextUsage: () => undefined,
				favoriteModels: [],
				scopedModels: [],
				get isStreaming() {
					return state.isStreaming;
				},
				get isBashRunning() {
					return state.isBashRunning;
				},
				// Composed through the production predicate so this fake cannot drift
				// from the contract the real AgentSession exposes.
				get isSessionBusy() {
					return isSessionBusySnapshot({
						isStreaming: state.isStreaming,
						isBashRunning: state.isBashRunning,
						isCompacting: state.isCompacting,
						hasSessionWork: state.hasSessionWork,
						hasActiveWakeSource: state.hasBackgroundJob,
					});
				},
				extensionRunner: { hasHandlers: () => false, emit: async () => {} },
				abort: async () => {},
				abortBash: () => {},
				waitForIdle: async () => {},
				dispose: () => {
					state.runtimeDisposals += 1;
				},
				messages: [],
				pendingMessageCount: 0,
			},
			services: { cwd: options.cwd, agentDir: options.agentDir },
			diagnostics: [],
		} as unknown as CreateAgentSessionRuntimeResult;
	};
	return { createRuntime, states };
}

interface RouterRig {
	router: SessionCommandRouter;
	registry: RpcSessionRegistry;
	writer: SessionEventWriter;
	records: Array<Record<string, unknown>>;
	bindingDisposals: () => number;
	uiRequestsCancelled: () => number;
}

/** Minimal binding stand-in: routing goes nowhere, disposal stays observable. */
function fakeBindingFactory(onDispose?: () => void, onCancelUiRequests?: () => void): RpcBindingFactory {
	return async () => ({
		handle: async () => {},
		dispose: async () => {
			onDispose?.();
		},
		cancelPendingExtensionUiRequests: () => {
			onCancelUiRequests?.();
		},
	});
}

function createRouterRig(
	dir: string,
	createRuntime: CreateAgentSessionRuntimeFactory,
	idle?: RpcSessionIdlePolicy,
	maxSessions?: number,
): RouterRig {
	const records: Array<Record<string, unknown>> = [];
	let bindingDisposals = 0;
	let uiRequestsCancelled = 0;
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime, maxSessions });
	const writer = new SessionEventWriter(
		(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
		(flush) => flush(),
	);
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: dir },
		fakeBindingFactory(
			() => {
				bindingDisposals += 1;
			},
			() => {
				uiRequestsCancelled += 1;
			},
		),
		{},
		idle,
	);
	return {
		router,
		registry,
		writer,
		records,
		bindingDisposals: () => bindingDisposals,
		uiRequestsCancelled: () => uiRequestsCancelled,
	};
}

/**
 * Resolved through a namespace import so the pre-fix state (no export yet)
 * fails this suite as per-test TypeErrors instead of a module-load error.
 */
const createHostCore = (
	multiSessionHost as unknown as {
		createHostCore?: (
			options: MultiSessionHostOptions,
			writer: SessionEventWriter,
			capabilities?: string[],
			idle?: {
				now?: () => number;
				idleEvictionMs?: number;
				emptyExitMs?: number;
				maxSessions?: number;
				onEmptyExit?: () => void;
			},
		) => { router: unknown; handle: (line: string) => Promise<void> };
	}
).createHostCore;

function requireHostCore(): NonNullable<typeof createHostCore> {
	if (typeof createHostCore !== "function") {
		throw new Error("createHostCore is not exported from multi-session-host.ts");
	}
	return createHostCore;
}

function openedSessionId(records: Array<Record<string, unknown>>): string {
	const sessionId = records.findLast(
		(record) => record.command === "open_session" && record.success !== false,
	)?.sessionId;
	if (typeof sessionId !== "string") throw new Error("open_session did not emit a routing handle");
	return sessionId;
}

const profile = (cwd: string, sessionPath: string): RpcSessionLaunchProfile => ({
	cwd,
	sessionPath,
	permissionPreset: "default",
	creationModel: { provider: "test", modelId: "model" },
	initialThinkingLevel: "high",
});

describe("shared RPC host occupancy", () => {
	const directories: string[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function tempDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "senpi-rpc-occupancy-"));
		directories.push(dir);
		return dir;
	}

	test("(4.1a) evicts sessions idle beyond the window through the normal close path", async () => {
		const dir = await tempDir();
		const { createRuntime, states } = createRuntimeFactory();
		const rig = createRouterRig(dir, createRuntime, {
			idleEvictionMs: IDLE_WINDOW_MS,
			emptyExitMs: Number.POSITIVE_INFINITY,
		});
		const sessionPath = join(dir, "idle.jsonl");
		await rig.router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath });
		const sessionId = openedSessionId(rig.records);
		expect(rig.registry.list()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);

		expect(rig.registry.list()).toHaveLength(0);
		expect(states[0]?.runtimeDisposals).toBe(1);
		expect(rig.bindingDisposals()).toBe(1);
		const closed = rig.records.find((record) => record.command === "close_session" && record.sessionId === sessionId);
		expect(closed).toMatchObject({ type: "response", success: true });
		// The path reservation is released, so a client can immediately resume.
		await rig.router.handle({ id: "reopen", type: "open_session", cwd: dir, sessionPath });
		expect(rig.registry.list()).toHaveLength(1);
		expect(openedSessionId(rig.records)).not.toBe(sessionId);
	});

	test("(4.1a) never evicts a session with an active turn and evicts one window after it settles", async () => {
		const dir = await tempDir();
		const { createRuntime, states } = createRuntimeFactory();
		const rig = createRouterRig(dir, createRuntime, {
			idleEvictionMs: IDLE_WINDOW_MS,
			emptyExitMs: Number.POSITIVE_INFINITY,
		});
		await rig.router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: join(dir, "turn.jsonl") });
		expect(rig.registry.list()).toHaveLength(1);

		states[0]!.isStreaming = true;
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 5);
		expect(rig.registry.list()).toHaveLength(1);
		expect(states[0]?.runtimeDisposals).toBe(0);

		states[0]!.isStreaming = false;
		// The idle clock restarts at settlement, not at the last command before the turn.
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS / 2);
		expect(rig.registry.list()).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);
		expect(rig.registry.list()).toHaveLength(0);
	});

	test.each([
		["a background terminal job", "hasBackgroundJob"],
		["a running bash command", "isBashRunning"],
		["compaction", "isCompacting"],
		["barrier-held session work", "hasSessionWork"],
	] as Array<[string, "hasBackgroundJob" | "isBashRunning" | "isCompacting" | "hasSessionWork"]>)(
		"(4.1a) defers eviction while %s outlives the turn",
		async (_label, source) => {
			const dir = await tempDir();
			const { createRuntime, states } = createRuntimeFactory();
			const rig = createRouterRig(dir, createRuntime, {
				idleEvictionMs: IDLE_WINDOW_MS,
				emptyExitMs: Number.POSITIVE_INFINITY,
			});
			await rig.router.handle({
				id: "open",
				type: "open_session",
				cwd: dir,
				sessionPath: join(dir, `${source}.jsonl`),
			});

			states[0]![source] = true;
			await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 4);
			expect(rig.registry.list()).toHaveLength(1);
			expect(states[0]?.runtimeDisposals).toBe(0);

			// Only once the work settles does the idle window start running again.
			states[0]![source] = false;
			await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS / 2);
			expect(rig.registry.list()).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);
			expect(rig.registry.list()).toHaveLength(0);
		},
	);

	test("(4.1a) routing a command refreshes the idle window", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const rig = createRouterRig(dir, createRuntime, {
			idleEvictionMs: IDLE_WINDOW_MS,
			emptyExitMs: Number.POSITIVE_INFINITY,
		});
		await rig.router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: join(dir, "touch.jsonl") });
		const sessionId = openedSessionId(rig.records);

		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 0.8);
		await rig.router.handle({ id: "prompt", type: "prompt", message: "still here", sessionId });
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 0.8);
		expect(rig.registry.list()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 0.6);
		expect(rig.registry.list()).toHaveLength(0);
	});

	test("(4.1a) evicting a shared session closes every attachment once and tolerates stale client closes", async () => {
		const dir = await tempDir();
		const { createRuntime, states } = createRuntimeFactory();
		const rig = createRouterRig(dir, createRuntime, {
			idleEvictionMs: IDLE_WINDOW_MS,
			emptyExitMs: Number.POSITIVE_INFINITY,
		});
		const sessionPath = join(dir, "shared.jsonl");
		await rig.router.handle({ id: "first", type: "open_session", cwd: dir, sessionPath });
		await rig.router.handle({ id: "second", type: "open_session", cwd: dir, sessionPath });
		const sessionId = openedSessionId(rig.records);
		expect(rig.registry.list()).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);

		expect(rig.registry.list()).toHaveLength(0);
		expect(states[0]?.runtimeDisposals).toBe(1);
		expect(rig.bindingDisposals()).toBe(1);
		expect(rig.uiRequestsCancelled()).toBeGreaterThanOrEqual(1);
		const staleClose = await rig.router.handle({ id: "late", type: "close_session", sessionId });
		expect(staleClose).toMatchObject({ success: false, error: "unknown_session" });
	});

	test("(4.1b) signals host exit once the registry stays empty, resetting on live sessions", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const onEmptyExit = vi.fn();
		const rig = createRouterRig(dir, createRuntime, {
			idleEvictionMs: Number.POSITIVE_INFINITY,
			emptyExitMs: 5_000,
			onEmptyExit,
		});

		await vi.advanceTimersByTimeAsync(4_000);
		expect(onEmptyExit).not.toHaveBeenCalled();

		await rig.router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: join(dir, "empty.jsonl") });
		const sessionId = openedSessionId(rig.records);
		await vi.advanceTimersByTimeAsync(2_000);
		await rig.router.handle({ id: "close", type: "close_session", sessionId });

		await vi.advanceTimersByTimeAsync(3_000);
		expect(onEmptyExit).not.toHaveBeenCalled();
		// Exit lands at the first tick at or beyond 5s of continuous emptiness.
		await vi.advanceTimersByTimeAsync(4_000);
		expect(onEmptyExit).toHaveBeenCalledTimes(1);
		// The sweep stops after exit: exactly once, ever.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(onEmptyExit).toHaveBeenCalledTimes(1);
	});

	test("(B2) never exits while a client is connected but sessionless, and exits once it disconnects", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const onEmptyExit = vi.fn();
		let connectedClients = 1;
		createRouterRig(dir, createRuntime, {
			idleEvictionMs: Number.POSITIVE_INFINITY,
			emptyExitMs: 2_000,
			onEmptyExit,
			canExitWhenEmpty: () => connectedClients === 0,
		});

		// A connected client with zero sessions is occupancy: exiting here would drop
		// its socket and read as a crash to the supervisor.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(onEmptyExit).not.toHaveBeenCalled();

		connectedClients = 0;
		// The window starts at disconnect, not before it.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(onEmptyExit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(onEmptyExit).toHaveBeenCalledTimes(1);
	});

	test("(follow-up) eviction leaves no sealed-handle residue for the evicted epoch", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const rig = createRouterRig(dir, createRuntime, {
			idleEvictionMs: IDLE_WINDOW_MS,
			emptyExitMs: Number.POSITIVE_INFINITY,
		});
		await rig.router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: join(dir, "sealed.jsonl") });
		const sessionId = openedSessionId(rig.records);

		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);
		expect(rig.registry.list()).toHaveLength(0);

		// Sealing keeps a torn-down session's records from trailing its close
		// response; it must not outlive the runtime it protected.
		expect(rig.writer.enqueue(sessionId, { type: "message_update" })).toBe(true);
	});

	test("(4.1b) router dispose stops the occupancy sweep", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const onEmptyExit = vi.fn();
		const rig = createRouterRig(dir, createRuntime, {
			idleEvictionMs: Number.POSITIVE_INFINITY,
			emptyExitMs: 1_000,
			onEmptyExit,
		});
		await rig.router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: join(dir, "gone.jsonl") });
		await rig.router.dispose();

		await vi.advanceTimersByTimeAsync(5_000);
		expect(onEmptyExit).not.toHaveBeenCalled();
	});

	test("(4.1b) host core arms the empty-host exit from explicit overrides", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const records: Array<Record<string, unknown>> = [];
		const writer = new SessionEventWriter(
			(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
			(flush) => flush(),
		);
		const onEmptyExit = vi.fn();
		const { handle } = requireHostCore()(
			{ agentDir: dir, createRuntime, cwd: dir, createBinding: fakeBindingFactory() },
			writer,
			[],
			{
				idleEvictionMs: Number.POSITIVE_INFINITY,
				emptyExitMs: 2_000,
				onEmptyExit,
			},
		);
		const line = (command: Record<string, unknown>): string => JSON.stringify(command);

		await handle(line({ id: "open", type: "open_session", cwd: dir, sessionPath: join(dir, "core.jsonl") }));
		await handle(line({ id: "close", type: "close_session", sessionId: openedSessionId(records) }));

		await vi.advanceTimersByTimeAsync(3_000);
		expect(onEmptyExit).toHaveBeenCalledTimes(1);
	});

	test("(4.2) rejects new open_session beyond the concurrent session cap while attach still works", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime, maxSessions: 2 });
		await registry.openSession(profile(dir, join(dir, "one.jsonl")));
		await registry.openSession(profile(dir, join(dir, "two.jsonl")));

		await expect(registry.openSession(profile(dir, join(dir, "three.jsonl")))).rejects.toMatchObject({
			code: "too_many_sessions",
		});
		// Attaching to a live session adds no runtime and must stay allowed at cap.
		await expect(registry.openSession(profile(dir, join(dir, "one.jsonl")))).resolves.toMatchObject({
			attached: true,
		});
		expect(registry.list()).toHaveLength(2);
	});

	test("(4.2) frees capacity when a capped session closes", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime, maxSessions: 1 });
		const first = await registry.openSession(profile(dir, join(dir, "solo.jsonl")));
		await registry.close(first.sessionId);
		await expect(registry.openSession(profile(dir, join(dir, "next.jsonl")))).resolves.toMatchObject({
			sessionId: expect.any(String),
		});
	});

	test("(4.2) surfaces the cap as a typed open_session error through the router", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		const rig = createRouterRig(
			dir,
			createRuntime,
			{ idleEvictionMs: Number.POSITIVE_INFINITY, emptyExitMs: Number.POSITIVE_INFINITY },
			1,
		);
		await rig.router.handle({ id: "open", type: "open_session", cwd: dir, sessionPath: join(dir, "cap.jsonl") });
		const response = await rig.router.handle({
			id: "over",
			type: "open_session",
			cwd: dir,
			sessionPath: join(dir, "over.jsonl"),
		});
		expect(response).toMatchObject({ success: false, error: "too_many_sessions" });
	});

	test("(4.2) host core resolves the session cap from SENPI_RPC_MAX_SESSIONS", async () => {
		const dir = await tempDir();
		const { createRuntime } = createRuntimeFactory();
		vi.stubEnv("SENPI_RPC_MAX_SESSIONS", "1");
		const records: Array<Record<string, unknown>> = [];
		const writer = new SessionEventWriter(
			(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
			(flush) => flush(),
		);
		const { handle } = requireHostCore()(
			{ agentDir: dir, createRuntime, cwd: dir, createBinding: fakeBindingFactory() },
			writer,
			[],
			{
				idleEvictionMs: Number.POSITIVE_INFINITY,
				emptyExitMs: Number.POSITIVE_INFINITY,
			},
		);
		const line = (command: Record<string, unknown>): string => JSON.stringify(command);

		await handle(line({ id: "first", type: "open_session", cwd: dir, sessionPath: join(dir, "env-one.jsonl") }));
		expect(records.some((record) => record.command === "open_session" && record.success === false)).toBe(false);
		await handle(line({ id: "second", type: "open_session", cwd: dir, sessionPath: join(dir, "env-two.jsonl") }));

		expect(records.find((record) => record.command === "open_session" && record.success === false)).toMatchObject({
			error: "too_many_sessions",
		});
	});
});
