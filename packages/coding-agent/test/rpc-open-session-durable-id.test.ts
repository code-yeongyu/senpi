import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { type RpcSessionLaunchProfile, RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";

/**
 * open_session.durableSessionId (#1951): the caller may name the durable session id so its
 * own record id and the session id are ONE value.
 *
 * The field is deliberately NOT called `sessionId`: session-command-router.ts reads
 * `"sessionId" in command` generically to drive drain gating, active-request accounting and
 * session attribution, so a caller-chosen durable id arriving under that key would be treated
 * as a routing handle.
 */

interface CapturedFactoryCall {
	cwd: string;
	sessionManager: SessionManager;
}

function makeFactory(calls: CapturedFactoryCall[]): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		new ProjectTrustStore(options.agentDir).set(options.cwd, true);
		calls.push({ cwd: options.cwd, sessionManager: options.sessionManager });
		return {
			session: {
				sessionManager: options.sessionManager,
				agentDir: options.agentDir,
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
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

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

function headerIdOf(path: string): string | undefined {
	const first = readFileSync(path, "utf8").split("\n")[0];
	return JSON.parse(first).id;
}

async function mkdtemp(): Promise<string> {
	const dir = join(tmpdir(), `senpi-durable-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("open_session.durableSessionId", () => {
	const cleanup: string[] = [];

	afterEach(() => {
		for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function makeRegistry(calls: CapturedFactoryCall[]) {
		const dir = await mkdtemp();
		cleanup.push(dir);
		return { dir, registry: new RpcSessionRegistry({ agentDir: dir, createRuntime: makeFactory(calls) }) };
	}

	test("create: the caller-supplied durable id becomes the session identity on disk", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);
		const sessionPath = join(dir, "chosen.jsonl");
		const chosen = "019ffec8-e1db-75fb-9da3-e5d753c0acea";

		const opened = await registry.openSession({ ...baseProfile(dir, sessionPath), durableSessionId: chosen });

		expect(opened.durableSessionId).toBe(chosen);
		appendAssistant(calls[0].sessionManager);
		await registry.close(opened.sessionId);
		expect(existsSync(sessionPath)).toBe(true);
		expect(headerIdOf(sessionPath)).toBe(chosen);
	});

	test("create: a malformed durable id is refused with invalid_session_id", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		await expect(
			registry.openSession({ ...baseProfile(dir, join(dir, "bad.jsonl")), durableSessionId: "../escape" }),
		).rejects.toMatchObject({ code: "invalid_session_id" });
		await expect(
			registry.openSession({ ...baseProfile(dir, join(dir, "empty.jsonl")), durableSessionId: "" }),
		).rejects.toMatchObject({ code: "invalid_session_id" });
		expect(calls).toHaveLength(0);
		expect(registry.list()).toHaveLength(0);
	});

	test("create: a durable id held by a LIVE session is refused with session_id_in_use", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);
		const chosen = "019ffec8-e1db-75fb-9da3-000000000001";

		const first = await registry.openSession({
			...baseProfile(dir, join(dir, "one.jsonl")),
			durableSessionId: chosen,
		});
		expect(first.durableSessionId).toBe(chosen);

		// A DIFFERENT path, same durable id: two live sessions may never share one durable id,
		// because every per-session artifact downstream is keyed by it.
		await expect(
			registry.openSession({ ...baseProfile(dir, join(dir, "two.jsonl")), durableSessionId: chosen }),
		).rejects.toMatchObject({ code: "session_id_in_use" });

		// Once the holder is closed the id is free again.
		await registry.close(first.sessionId);
		const reused = await registry.openSession({
			...baseProfile(dir, join(dir, "three.jsonl")),
			durableSessionId: chosen,
		});
		expect(reused.durableSessionId).toBe(chosen);
		await registry.close(reused.sessionId);
	});

	test("resume: a supplied durable id never overwrites the header id", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);
		const sessionPath = join(dir, "existing.jsonl");
		writeSessionFile(sessionPath, "durable-on-disk", dir);

		const opened = await registry.openSession({
			...baseProfile(dir, sessionPath),
			durableSessionId: "019ffec8-e1db-75fb-9da3-000000000002",
		});

		expect(opened.durableSessionId).toBe("durable-on-disk");
		expect(headerIdOf(sessionPath)).toBe("durable-on-disk");
		await registry.close(opened.sessionId);
	});

	test("create: without a durable id the host still mints its own", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);

		const opened = await registry.openSession(baseProfile(dir, join(dir, "minted.jsonl")));

		expect(opened.durableSessionId).toBeTruthy();
		expect(opened.durableSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
		await registry.close(opened.sessionId);
	});

	test("wire: a malformed durable id is refused at the boundary, before any session is built", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: dir });

		const response = await router.handle({
			id: "bad-durable-id",
			type: "open_session",
			cwd: dir,
			sessionPath: join(dir, "wire.jsonl"),
			durableSessionId: "no spaces allowed",
		});

		expect(response).toMatchObject({ command: "open_session", success: false });
		expect(String((response as { error?: unknown }).error)).toContain("invalid_session_id");
		expect(calls).toHaveLength(0);
	});

	test("wire: get_protocol_info advertises durable_session_id", async () => {
		const calls: CapturedFactoryCall[] = [];
		const { dir, registry } = await makeRegistry(calls);
		const router = new SessionCommandRouter(registry, new SessionEventWriter(() => {}), { cwd: dir });

		const response = (await router.handle({ id: "caps", type: "get_protocol_info" })) as {
			data?: { capabilities?: string[] };
		};

		expect(response.data?.capabilities).toContain("durable_session_id");
	});
});
