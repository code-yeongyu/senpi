/**
 * In-process classic-RPC characterization helpers (todo 2).
 *
 * Mirrors the harness in `test/rpc-prompt-response-semantics.test.ts`. The
 * `vi.mock` calls MUST live in the test file itself (vitest hoists them per
 * file), so this module exports only the mock-independent helpers: the mock
 * assistant stream, a fake `AgentSessionRuntime` whose `session` getter is
 * mutable (so `new_session`/`switch_session`/`fork` can be characterized as
 * rebinding the single active session), and small line-parsing utilities.
 *
 * Every line the connection-handler writes (responses, events, extension-UI
 * requests) flows through the mocked `writeRawStdout` sink captured in the test
 * file — exactly the boundary the multi-session host (todo 8/9) will tag with
 * `sessionId`. Pins assert that boundary carries NO top-level `sessionId` today.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";

/** Captured wire state shared between the mocked modules and the test. */
export interface FakeRpcIo {
	/** Every raw chunk written to `writeRawStdout`, in order. */
	outputLines: string[];
	/** The injected stdin line handler; commands are driven through this. */
	lineHandler: ((line: string) => void) | undefined;
}

/**
 * The mutable handle returned to a test. `host.session` is the live getter the
 * connection-handler reads during `rebindSession`; swapping it characterizes
 * `new_session`/`switch_session`/`fork` rebinding the single active session.
 */
export interface FakeRuntimeHost {
	runtimeHost: AgentSessionRuntime;
	cleanup(): Promise<void>;
}

export interface CreateHostOptions {
	/** When true, the host has a SECOND session available for swap-based commands. */
	withSwapSession: boolean;
	/** When true, auth is configured so prompt preflight succeeds. */
	withAuth: boolean;
	/** Delay before the mock assistant stream completes (ms). */
	responseDelayMs: number;
	/** Override model (defaults to a real anthropic builtin model). */
	model?: Model<any>;
}

export class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function createAgentSession(
	tempDir: string,
	model: Model<any>,
	withAuth: boolean,
	responseDelayMs: number,
	authStorage: AuthStorage,
): Promise<{ session: AgentSession; cleanup: () => Promise<void> }> {
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				}, responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const modelRegistry = await createModelRegistry(authStorage, tempDir);
	if (withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	return {
		session,
		cleanup: async () => {
			try {
				if (session.isStreaming) await session.abort();
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
		},
	};
}

/**
 * Build a fake `AgentSessionRuntime` whose `session` getter is mutable so
 * `new_session`/`switch_session`/`fork` can be characterized as rebinding the
 * single active session. The `newSession`/`switchSession`/`fork` stubs swap the
 * live session and report `cancelled: false` so the connection-handler's
 * `rebindSession()` runs against the new session.
 */
export async function createFakeRuntimeHost(options: CreateHostOptions): Promise<FakeRuntimeHost> {
	const tempDir = join(tmpdir(), `pi-rpc-classic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Test model not found");

	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const primary = await createAgentSession(tempDir, model, options.withAuth, options.responseDelayMs, authStorage);
	let secondary: { session: AgentSession; cleanup: () => Promise<void> } | undefined;
	if (options.withSwapSession) {
		secondary = await createAgentSession(tempDir, model, options.withAuth, options.responseDelayMs, authStorage);
	}

	let live = primary.session;
	const host = {
		get session() {
			return live;
		},
		newSession: vi.fn(async () => {
			if (secondary) live = secondary.session;
			return { cancelled: false };
		}),
		switchSession: vi.fn(async () => {
			if (secondary) live = secondary.session;
			return { cancelled: false };
		}),
		fork: vi.fn(async () => {
			if (secondary) live = secondary.session;
			return { cancelled: false, selectedText: "forked" };
		}),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost: host,
		cleanup: async () => {
			await primary.cleanup();
			await secondary?.cleanup();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Line parsing utilities
// ---------------------------------------------------------------------------

export type ParsedOutputLine = Record<string, unknown>;

/**
 * Parse the captured raw chunks into individual JSON records.
 *
 * A single `writeRawStdout` chunk may contain multiple LF-separated records
 * (the event-output-buffer coalesces same-tick events into one write), so this
 * splits on `\n` and discards empty trailing fragments.
 */
export function parseOutputLines(outputLines: readonly string[]): ParsedOutputLine[] {
	return outputLines
		.join("")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}
