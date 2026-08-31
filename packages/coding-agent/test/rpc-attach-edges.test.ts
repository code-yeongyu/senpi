import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runtime(options: Parameters<CreateAgentSessionRuntimeFactory>[0]): CreateAgentSessionRuntimeResult {
	new ProjectTrustStore(options.agentDir).set(options.cwd, true);
	return {
		session: {
			sessionManager: options.sessionManager,
			agentDir: options.agentDir,
			isFastModeActive: () => false,
			isStreaming: false,
			// The shared state builder projects open_session through the full session
			getContextUsage: () => undefined,
			favoriteModels: [],
			scopedModels: [],
			isBashRunning: false,
			extensionRunner: { hasHandlers: () => false, emit: async () => {} },
			abort: async () => {},
			waitForIdle: async () => {},
			dispose: () => {},
			messages: [],
			pendingMessageCount: 0,
		},
		services: { cwd: options.cwd, agentDir: options.agentDir },
		diagnostics: [],
	} as unknown as CreateAgentSessionRuntimeResult;
}

async function setup(createRuntime?: CreateAgentSessionRuntimeFactory) {
	const dir = await mkdtemp(join(tmpdir(), "senpi-rpc-edges-"));
	directories.push(dir);
	const registry = new RpcSessionRegistry({
		agentDir: dir,
		createRuntime: createRuntime ?? (async (options) => runtime(options)),
	});
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection("connection", { writeRaw: () => {}, waitForBackpressure: async () => {} });
	const router = new SessionCommandRouter(registry, writer, { cwd: dir }, async () => ({
		handle: async () => {},
		dispose: async () => {},
	}));
	return { dir, registry, writer, router };
}

const open = (cwd: string, sessionPath: string) => ({
	type: "open_session" as const,
	cwd,
	sessionPath,
});

describe("RPC attachment edge regressions", () => {
	test("releases every same-connection duplicate attachment, while explicit close releases one", async () => {
		const { dir, registry } = await setup();
		const path = join(dir, "same.jsonl");
		const records: Record<string, unknown>[] = [];
		const recordingWriter = new SessionEventWriter(
			(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
			async () => {},
			(flush) => void flush(),
		);
		recordingWriter.registerConnection("connection", {
			writeRaw: (chunk) => records.push(JSON.parse(chunk)),
			waitForBackpressure: async () => {},
		});
		const attachedRouter = new SessionCommandRouter(registry, recordingWriter, { cwd: dir }, async () => ({
			handle: async () => {},
			dispose: async () => {},
		}));
		await recordingWriter.withConnection("connection", () => attachedRouter.handle(open(dir, path)));
		await recordingWriter.flush();
		await recordingWriter.withConnection("connection", () => attachedRouter.handle(open(dir, path)));
		await recordingWriter.flush();
		const id = registry.list()[0]?.sessionId;
		expect(id).toEqual(expect.any(String));
		if (typeof id !== "string") throw new Error("missing session id");
		await recordingWriter.withConnection("connection", () =>
			attachedRouter.handle({ type: "close_session", sessionId: id }),
		);
		await recordingWriter.flush();
		expect(registry.list()).toHaveLength(1);
		await attachedRouter.releaseConnection("connection");
		expect(registry.list()).toEqual([]);
	});

	test("disconnect waits for an in-flight open before releasing its reservation", async () => {
		let releaseRuntime!: () => void;
		const runtimeReady = new Promise<void>((resolve) => {
			releaseRuntime = resolve;
		});
		const { dir, registry, writer, router } = await setup(async (options) => {
			await runtimeReady;
			return runtime(options);
		});
		const opening = writer.withConnection("connection", () => router.handle(open(dir, join(dir, "race.jsonl"))));
		const released = router.releaseConnection("connection");
		await Promise.resolve();
		expect(registry.list()[0]?.status).toBe("opening");
		releaseRuntime();
		await Promise.all([opening, released]);
		expect(registry.list()).toEqual([]);
	});

	test("open-session response data exposes the attachment marker", () => {
		const response: RpcResponse = {
			type: "response",
			command: "open_session",
			success: true,
			data: { sessionId: "rpc-1", state: {} as never, attached: true },
		};
		expect((response as Extract<RpcResponse, { command: "open_session"; success: true }>).data.attached).toBe(true);
	});

	test("reports preflight failure when transport write throws synchronously", async () => {
		const client = new RpcClient();
		const writeError = new Error("write failed");
		(client as unknown as { socket: unknown }).socket = {
			destroyed: false,
			writable: true,
			write: () => {
				throw writeError;
			},
		};
		const results: boolean[] = [];
		await expect(client.prompt("hello", { preflightResult: (success) => results.push(success) })).rejects.toBe(
			writeError,
		);
		expect(results).toEqual([false]);
	});
});
