import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { DEFAULT_HOST_RSS_WARN_MB, HostMemorySampler } from "../../../src/modes/rpc/host-memory-sampler.ts";
import type { RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

// senpi#2207: the shared host has no resource caps. Memory is reported and idle sessions park
// sooner under pressure, but no open is ever refused for memory: the RSS refuse watermark that
// #1905 added declined every task child on the machine once a long-lived host crossed it.

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
	readonly pressure: Array<Record<string, unknown>>;
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
	const pressure: Array<Record<string, unknown>> = [];
	const sampler = new HostMemorySampler({
		emit: (record) => pressure.push({ ...record }),
		sessions: () => router.sessionCount,
		onPressure: (active) => router.setMemoryPressure(active),
		log: () => {},
		readFootprint: () => ({ bytes: rssBytes, measure: "phys_footprint" }),
		readRssBytes: () => rssBytes,
		env: { SENPI_RPC_HOST_RSS_REFUSE_MB: "1" },
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
		pressure,
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

describe("issue 2207: memory never refuses an open", () => {
	const directories: string[] = [];
	afterEach(async () => {
		await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("admits a NEW worker session far above every former watermark, and still reports the pressure", async () => {
		// Given: a host four times over its warning threshold, with the retired refuse variable set
		const host = await createHost(directories);
		try {
			const rssMb = DEFAULT_HOST_RSS_WARN_MB * 4;
			host.setRssMb(rssMb);

			// When: a client opens a new worker session
			const response = await host.openWorker(join(host.dir, "worker.jsonl"));

			// Then: it is admitted, and the pressure record still went out
			expect(response).toBeUndefined();
			expect(host.router.sessionCount).toBe(1);
			expect(host.pressure).toContainEqual({
				type: "host_memory_pressure",
				rssMb,
				footprintMb: rssMb,
				measure: "phys_footprint",
				sessions: 0,
				main: { heapBytes: expect.any(Number) },
				kernels: [],
			});
		} finally {
			await host.router.dispose();
		}
	});

	it("serves interactive opens, attaches to a live worker path and existing sessions under pressure", async () => {
		// Given: a worker session opened before the host came under pressure
		const host = await createHost(directories);
		try {
			const workerPath = join(host.dir, "live-worker.jsonl");
			expect(await host.openWorker(workerPath)).toBeUndefined();
			const workerId = host.openedSessionId("open-1");
			if (workerId === undefined) throw new Error("worker session did not open");
			host.setRssMb(DEFAULT_HOST_RSS_WARN_MB * 4);

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
});
