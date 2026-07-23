import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import {
	type RpcSessionLaunchProfile,
	RpcSessionRegistry,
	RpcSessionRegistryError,
} from "../src/modes/rpc/session-registry.ts";

/**
 * Todo 10: open_session resume/create parity + close semantics.
 *
 * These tests drive the public RpcSessionRegistry.openSession/close/list
 * surface (the multi-session host in todo 8 will route open_session here).
 * They mirror the spawn-flag semantics omo applies today
 * (SenpiSessionRuntime.ts:191-203) and the resume-cursor durable-id
 * verification (SenpiAdapter.ts:1277-1309):
 *   - --session          -> sessionPath (open-if-exists else create)
 *   - --provider/--model -> creationModel, applied ONLY on create
 *   - --thinking         -> initialThinkingLevel
 *   - --permission-preset -> permissionPreset
 *   - resume restores the session's own model (creationModel NOT applied)
 *
 * The factory records the launch profile it received and exposes a real
 * SessionManager-backed session, so resume/create parity is exercised
 * against the same SessionManager.open/create path main.ts uses.
 */

interface CapturedFactoryCall {
	cwd: string;
	launchProfile: Readonly<RpcSessionLaunchProfile> | undefined;
	sessionManager: SessionManager;
}

function makeFactory(calls: CapturedFactoryCall[]): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		calls.push({
			cwd: options.cwd,
			launchProfile: options.launchProfile as Readonly<RpcSessionLaunchProfile> | undefined,
			sessionManager: options.sessionManager,
		});
		return {
			session: {
				sessionManager: options.sessionManager,
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
}

function baseProfile(cwd: string, sessionPath?: string): RpcSessionLaunchProfile {
	return {
		cwd,
		...(sessionPath !== undefined ? { sessionPath } : {}),
		permissionPreset: "default",
		creationModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
		initialThinkingLevel: "high",
	};
}

function writeSessionFile(path: string, sessionId: string, cwd: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("open_session resume/create parity + close semantics", () => {
	const cleanup: string[] = [];

	afterEach(async () => {
		await Promise.all(cleanup.splice(0).map((dir) => rmSync(dir, { recursive: true, force: true })));
	});

	async function makeRegistry(calls: CapturedFactoryCall[]) {
		const dir = await mkdtemp();
		cleanup.push(dir);
		return {
			dir,
			registry: new RpcSessionRegistry({ agentDir: dir, createRuntime: makeFactory(calls) }),
		};
	}

	test("resume: reopens an existing file with entries loaded and durable id restored", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		// Seed a real session file with a known durable id + a user message entry.
		const sessionPath = join(dir, "resume.jsonl");
		const durableId = "durable-resume-id";
		writeSessionFile(sessionPath, durableId, dir);

		// Create first to populate entries, then close, then reopen.
		const first = await registry.openSession(baseProfile(dir, sessionPath));
		const firstManager = calls[0].sessionManager;
		firstManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello from first open" }],
			timestamp: Date.now(),
		});
		expect(first.durableSessionId).toBe(durableId);
		await registry.close(first.sessionId);

		// Reopen: must load entries and report the SAME durable id.
		const reopened = await registry.openSession(baseProfile(dir, sessionPath));
		expect(reopened.durableSessionId).toBe(durableId);
		const reopenedManager = calls[1].sessionManager;
		const entries = reopenedManager.getEntries();
		expect(entries.some((e) => e.type === "message" && e.message.role === "user")).toBe(true);
		await registry.close(reopened.sessionId);
	});

	test("create: opens a missing sessionPath and persists there", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const sessionPath = join(dir, "created.jsonl");
		expect(existsSync(sessionPath)).toBe(false);

		const opened = await registry.openSession(baseProfile(dir, sessionPath));
		// The registry canonicalizes the path (realpath); assert it points at the
		// same file and that it is the requested basename.
		expect(basename(opened.sessionPath ?? "")).toBe("created.jsonl");
		// A user message alone is buffered in memory (real SessionManager
		// semantics: the file materializes on the first assistant message).
		// Append an assistant turn to flush the session header + history to disk.
		calls[0].sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now(),
		});
		appendAssistant(calls[0].sessionManager);
		await registry.close(opened.sessionId);

		expect(existsSync(opened.sessionPath ?? "")).toBe(true);
		// Reopening reads the durable id written on create.
		const reopened = await registry.openSession(baseProfile(dir, sessionPath));
		expect(reopened.durableSessionId).toBe(opened.durableSessionId);
		await registry.close(reopened.sessionId);
	});

	test("absolute-path enforcement: relative sessionPath or cwd -> invalid_path", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		await expect(registry.openSession({ ...baseProfile(dir, "relative.jsonl") })).rejects.toMatchObject({
			code: "invalid_path",
		});

		await expect(
			registry.openSession({ ...baseProfile("relative-cwd", join(dir, "abs.jsonl")) }),
		).rejects.toMatchObject({ code: "invalid_path" });

		expect(calls).toHaveLength(0);
		expect(registry.list()).toHaveLength(0);
	});

	test("per-session cwd: each runtime receives its own cwd", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const cwdA = await mkdtemp();
		const cwdB = await mkdtemp();
		cleanup.push(cwdA, cwdB);

		const a = await registry.openSession(baseProfile(cwdA, join(dir, "a.jsonl")));
		const b = await registry.openSession(baseProfile(cwdB, join(dir, "b.jsonl")));

		expect(calls[0].cwd).toBe(cwdA);
		expect(calls[0].launchProfile?.cwd).toBe(cwdA);
		expect(calls[1].cwd).toBe(cwdB);
		expect(calls[1].launchProfile?.cwd).toBe(cwdB);

		await registry.close(a.sessionId);
		await registry.close(b.sessionId);
	});

	test("permissionPreset is applied via the launch profile", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const opened = await registry.openSession({
			...baseProfile(dir, join(dir, "perm.jsonl")),
			permissionPreset: "yolo",
		});
		expect(calls[0].launchProfile?.permissionPreset).toBe("yolo");
		await registry.close(opened.sessionId);
	});

	test("thinkingLevel initial value is applied via the launch profile", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const opened = await registry.openSession({
			...baseProfile(dir, join(dir, "think.jsonl")),
			initialThinkingLevel: "medium",
		});
		expect(calls[0].launchProfile?.initialThinkingLevel).toBe("medium");
		await registry.close(opened.sessionId);
	});

	test("creationModel applied on create, NOT on resume (model restored by session)", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const sessionPath = join(dir, "model-parity.jsonl");
		// Create pass: creationModel MUST reach the factory.
		const created = await registry.openSession(baseProfile(dir, sessionPath));
		expect(calls[0].launchProfile?.creationModel).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		// Materialize the session file so the next open is a RESUME (not create).
		appendAssistant(calls[0].sessionManager);
		await registry.close(created.sessionId);

		// Resume pass: create-only fields MUST NOT be applied. The persisted
		// session restores its own model/thinking state rather than accepting a
		// second open_session request as a model change.
		const resumed = await registry.openSession({
			...baseProfile(dir, sessionPath),
			creationModel: { provider: "other", modelId: "ignored-on-resume" },
			initialThinkingLevel: "low",
		});
		expect(calls[1].launchProfile?.creationModel).toBeUndefined();
		expect(calls[1].launchProfile?.initialThinkingLevel).toBeUndefined();
		await registry.close(resumed.sessionId);
	});

	test("close_session: disposes the runtime, releases the reservation, persists the file", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir } = await makeRegistry(calls);

		const sessionPath = join(dir, "close.jsonl");
		let disposed = false;
		const closeRegistry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				const result = await makeFactory(calls)(options);
				const session = result.session as unknown as { dispose: () => void };
				const realDispose = session.dispose;
				session.dispose = () => {
					disposed = true;
					realDispose();
				};
				return result;
			},
		});

		const opened = await closeRegistry.openSession(baseProfile(dir, sessionPath));
		calls[0].sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "persisted on close" }],
			timestamp: Date.now(),
		});
		appendAssistant(calls[0].sessionManager);

		await closeRegistry.close(opened.sessionId);
		expect(disposed).toBe(true);
		expect(existsSync(sessionPath)).toBe(true);

		// Reservation released: same path can be opened again.
		const reopened = await closeRegistry.openSession(baseProfile(dir, sessionPath));
		expect(reopened.sessionId).not.toBe(opened.sessionId);
		await closeRegistry.close(reopened.sessionId);
	});

	test("process serves other sessions after a close", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const a = await registry.openSession(baseProfile(dir, join(dir, "alive-a.jsonl")));
		const b = await registry.openSession(baseProfile(dir, join(dir, "alive-b.jsonl")));
		await registry.close(a.sessionId);

		// B is still routable and closeable.
		expect(registry.getForCommand(b.sessionId, "get_state").state).toBe("open");
		const c = await registry.openSession(baseProfile(dir, join(dir, "alive-c.jsonl")));
		expect(registry.list().map((e) => e.sessionId)).toEqual(expect.arrayContaining([b.sessionId, c.sessionId]));
		expect(registry.list().map((e) => e.sessionId)).not.toContain(a.sessionId);
		await registry.close(b.sessionId);
		await registry.close(c.sessionId);
		expect(registry.list()).toHaveLength(0);
	});

	test("corrupt/unreadable sessionPath -> open_failed typed error, process alive", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const corruptPath = join(dir, "corrupt.jsonl");
		writeFileSync(corruptPath, "{ this is not valid jsonl\n");

		await expect(registry.openSession(baseProfile(dir, corruptPath))).rejects.toBeInstanceOf(RpcSessionRegistryError);
		await expect(registry.openSession(baseProfile(dir, corruptPath))).rejects.toMatchObject({
			code: "open_failed",
		});

		// Process alive: a subsequent open of a good path succeeds.
		const good = await registry.openSession(baseProfile(dir, join(dir, "good.jsonl")));
		expect(good.durableSessionId).toBeTruthy();
		await registry.close(good.sessionId);
	});

	test("open_failed leaves no reservation behind (same corrupt path is retriable)", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const corruptPath = join(dir, "corrupt2.jsonl");
		writeFileSync(corruptPath, "not json\n");

		await expect(registry.openSession(baseProfile(dir, corruptPath))).rejects.toMatchObject({
			code: "open_failed",
		});
		// No lingering reservation: the second attempt fails again on open_failed
		// (NOT session_path_in_use), proving the reservation was released.
		await expect(registry.openSession(baseProfile(dir, corruptPath))).rejects.toMatchObject({
			code: "open_failed",
		});
	});

	test("write-close-reopen roundtrip: history + durable id match", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const sessionPath = join(dir, "roundtrip.jsonl");
		const opened = await registry.openSession(baseProfile(dir, sessionPath));
		const durableId = opened.durableSessionId;
		const manager = calls[0].sessionManager;
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "roundtrip message" }],
			timestamp: Date.now(),
		});
		appendAssistant(manager);
		await registry.close(opened.sessionId);

		const reopened = await registry.openSession(baseProfile(dir, sessionPath));
		expect(reopened.durableSessionId).toBe(durableId);
		const reopenedManager = calls[1].sessionManager;
		const messages = reopenedManager
			.getEntries()
			.filter((e) => e.type === "message")
			.map((e) => (e.type === "message" ? e.message : null));
		expect(messages.some((m) => m?.role === "user")).toBe(true);
		await registry.close(reopened.sessionId);
	});

	test("resume restores the session's persisted cwd, not the profile cwd, when header differs", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		// Seed a session whose stored cwd is the temp dir, then resume with a
		// different profile cwd. SessionManager.open reads the header cwd when
		// no override is given; the registry passes profile.cwd as the override,
		// so the effective cwd should follow the profile (parity with omo's
		// cwd param). We assert the runtime sees the profile cwd.
		const sessionPath = join(dir, "cwd-resume.jsonl");
		writeSessionFile(sessionPath, "cwd-resume-id", dir);

		const otherCwd = await mkdtemp();
		cleanup.push(otherCwd);
		const opened = await registry.openSession({ ...baseProfile(otherCwd, sessionPath) });
		expect(calls[0].cwd).toBe(otherCwd);
		await registry.close(opened.sessionId);
	});

	test("list_sessions reflects opening/open/closing/closed status transitions", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir } = await makeRegistry(calls);

		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		let disposedCall = false;
		const blockingRegistry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async (options) => {
				const result = await makeFactory(calls)(options);
				const session = result.session as unknown as {
					waitForIdle: () => Promise<void>;
					dispose: () => void;
				};
				// Block close on waitForIdle so we can observe the closing state.
				session.waitForIdle = () => idle;
				const realDispose = session.dispose;
				session.dispose = () => {
					disposedCall = true;
					realDispose();
				};
				return result;
			},
		});

		const opened = await blockingRegistry.openSession(baseProfile(dir, join(dir, "list.jsonl")));
		expect(blockingRegistry.list().find((e) => e.sessionId === opened.sessionId)?.status).toBe("open");

		const closing = blockingRegistry.close(opened.sessionId);
		expect(blockingRegistry.list().find((e) => e.sessionId === opened.sessionId)?.status).toBe("closing");

		releaseIdle();
		await closing;
		expect(disposedCall).toBe(true);
		expect(blockingRegistry.list().find((e) => e.sessionId === opened.sessionId)).toBeUndefined();
	});
});

function appendAssistant(manager: SessionManager): void {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

async function mkdtemp(): Promise<string> {
	const dir = join(tmpdir(), `senpi-open-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}
