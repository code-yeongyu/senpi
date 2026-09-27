import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import {
	DEFAULT_HOST_RSS_WARN_MB,
	HOST_MEMORY_SAMPLE_MS,
	HostMemorySampler,
} from "../../../src/modes/rpc/host-memory-sampler.ts";
import type { RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

// senpi#1905: above the warning threshold the host only halved idle parking, and nothing
// bounded admission as RSS climbed past 9 GB into a runtime crash that took every session
// with it. Above a HIGH watermark a NEW worker session is now refused with a retryable
// code; interactive opens, attaches to a live path and every existing session are served.

const MEGABYTE = 1024 * 1024;

function runtime(options: Parameters<CreateAgentSessionRuntimeFactory>[0]): CreateAgentSessionRuntimeResult {
	new ProjectTrustStore(options.agentDir).set(options.cwd, true);
	return {
		session: {
			sessionManager: options.sessionManager,
			agentDir: options.agentDir,
			isFastModeActive: () => false,
			agent: { state: {} },
			getContextUsage: () => undefined,
			favoriteModels: [],
			scopedModels: [],
			isBashRunning: false,
			isStreaming: false,
			extensionRunner: { hasHandlers: () => false, emit: async () => {} },
			abort: async () => {},
			abortBash: () => {},
			waitForIdle: async () => {},
			dispose: () => {},
			messages: [],
			pendingMessageCount: 0,
		},
		services: { cwd: options.cwd, agentDir: options.agentDir },
		diagnostics: [],
	} as unknown as CreateAgentSessionRuntimeResult;
}

interface Host {
	readonly dir: string;
	readonly router: SessionCommandRouter;
	readonly records: Array<Record<string, unknown>>;
	setRssMb(rssMb: number): void;
	openWorker(sessionPath: string): Promise<RpcResponse | undefined>;
	openInteractive(sessionPath: string): Promise<RpcResponse | undefined>;
	openedSessionId(requestId: string): string | undefined;
}

async function createHost(directories: string[]): Promise<Host> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-1905-admission-"));
	directories.push(dir);
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime: async (options) => runtime(options) });
	const records: Array<Record<string, unknown>> = [];
	const writer = new SessionEventWriter(
		(chunk) => records.push(JSON.parse(chunk) as Record<string, unknown>),
		(flush) => flush(),
	);
	const router = new SessionCommandRouter(registry, writer, { cwd: dir }, async () => ({
		handle: async () => {},
		dispose: async () => {},
	}));
	let rssBytes = 0;
	const sampler = new HostMemorySampler({
		emit: () => {},
		sessions: () => router.sessionCount,
		onPressure: (pressure) => router.setMemoryPressure(pressure),
		onCritical: (critical, rssMb) => router.setMemoryCritical(critical, rssMb),
		log: () => {},
		readRssBytes: () => rssBytes,
		env: {},
	});
	let requests = 0;
	const open = (sessionPath: string, kind: "worker" | undefined) =>
		router.handle({
			id: `open-${++requests}`,
			type: "open_session",
			cwd: dir,
			sessionPath,
			...(kind === undefined ? {} : { kind }),
			retain_on_disconnect: true,
		});
	return {
		dir,
		router,
		records,
		setRssMb: (rssMb) => {
			rssBytes = rssMb * MEGABYTE;
			sampler.sample();
		},
		openWorker: (sessionPath) => open(sessionPath, "worker"),
		openInteractive: (sessionPath) => open(sessionPath, undefined),
		openedSessionId: (requestId) => {
			const response = records.find((record) => record.id === requestId && record.command === "open_session");
			return typeof response?.sessionId === "string" ? response.sessionId : undefined;
		},
	};
}

describe("issue 1905: worker admission above the critical RSS watermark", () => {
	const directories: string[] = [];
	afterEach(async () => {
		await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("refuses a NEW worker session with host_memory_pressure and a retry hint", async () => {
		// Given: a host above twice its warning threshold
		const host = await createHost(directories);
		try {
			host.setRssMb(DEFAULT_HOST_RSS_WARN_MB * 2 + 1);

			// When: a client opens a new worker session
			const response = await host.openWorker(join(host.dir, "worker.jsonl"));

			// Then: the open is refused with the retryable code, and no session was created
			expect(response).toMatchObject({
				success: false,
				error: "host_memory_pressure",
				errorCode: "host_memory_pressure",
				errorData: { rssMb: DEFAULT_HOST_RSS_WARN_MB * 2 + 1, retry_after_ms: HOST_MEMORY_SAMPLE_MS },
			});
			expect(host.router.sessionCount).toBe(0);
		} finally {
			await host.router.dispose();
		}
	});

	it("still serves interactive opens, attaches to a live worker path and existing sessions", async () => {
		// Given: a worker session opened before the host went critical
		const host = await createHost(directories);
		try {
			const workerPath = join(host.dir, "live-worker.jsonl");
			expect(await host.openWorker(workerPath)).toBeUndefined();
			const workerId = host.openedSessionId("open-1");
			if (workerId === undefined) throw new Error("worker session did not open");
			host.setRssMb(DEFAULT_HOST_RSS_WARN_MB * 2 + 1);

			// When: an interactive open, a reattach to the live worker path, and a command on it
			const interactive = await host.openInteractive(join(host.dir, "interactive.jsonl"));
			const reattach = await host.openWorker(workerPath);
			const state = await host.router.handle({ id: "state", type: "get_state", sessionId: workerId });

			// Then: none of them is refused
			expect(interactive).toBeUndefined();
			expect(reattach).toBeUndefined();
			expect(state).not.toMatchObject({ success: false });
			expect(host.records.find((record) => record.id === "open-3")).toMatchObject({ data: { attached: true } });
		} finally {
			await host.router.dispose();
		}
	});

	it("admits worker sessions again once RSS falls back under the watermark", async () => {
		// Given: a host that was critical
		const host = await createHost(directories);
		try {
			host.setRssMb(DEFAULT_HOST_RSS_WARN_MB * 2 + 1);
			expect(await host.openWorker(join(host.dir, "refused.jsonl"))).toMatchObject({
				error: "host_memory_pressure",
			});

			// When: memory returns under the watermark (still above the warning threshold)
			host.setRssMb(DEFAULT_HOST_RSS_WARN_MB + 1);

			// Then: the next worker open is admitted
			expect(await host.openWorker(join(host.dir, "admitted.jsonl"))).toBeUndefined();
			expect(host.router.sessionCount).toBe(1);
		} finally {
			await host.router.dispose();
		}
	});
});
