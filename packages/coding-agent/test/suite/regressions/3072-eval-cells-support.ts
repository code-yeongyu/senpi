import { afterEach, vi } from "vitest";
import senpiCodemode, { type CodemodeExtensionAPI } from "../../../../senpi-codemode/src/index.ts";
import { FakeKernel, fakeExtensionContext } from "../../../../senpi-codemode/test/eval/fakes.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";

interface RpcFixture {
	readonly harness: Harness;
	readonly connection: RpcConnectionHandler;
	readonly chunks: string[];
}

interface Fixture extends RpcFixture {
	readonly kernel: FakeKernel;
	readonly notices: unknown[];
	readonly tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0];
	readonly context: ReturnType<typeof fakeExtensionContext>;
}

const fixtures: RpcFixture[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		await f.harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
		await f.connection.dispose();
		f.harness.cleanup();
	}
	vi.useRealTimers();
});

export async function rpcFixture(harness: Harness): Promise<RpcFixture> {
	const chunks: string[] = [];
	// Same runtime-host seam as rpc-extension-requests.test.ts; replacement is not exercised.
	const host = {
		session: harness.session,
		setRebindSession: () => {},
		dispose: async () => {},
	} as AgentSessionRuntime;
	const connection = createRpcConnectionHandler(
		host,
		{ writeRaw: (chunk) => chunks.push(chunk), waitForBackpressure: async () => {} },
		{
			sessionId: harness.sessionManager.getSessionId(),
			capabilities: ["extension_events"],
			eventFlushScheduler: (flush) => flush(),
		},
	);
	await connection.ready;
	const f = { harness, connection, chunks };
	fixtures.push(f);
	return f;
}

export async function fixture(): Promise<Fixture> {
	const kernel = new FakeKernel([]);
	const notices: unknown[] = [];
	let tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) =>
				senpiCodemode(
					{
						...pi,
						registerTool: (registered) => {
							tool = registered;
							pi.registerTool(registered);
						},
						sendMessage: (message, options) => notices.push({ message, options }),
					},
					{
						createSessionManager: () => ({
							getKernel: async (_language, onMessage) => {
								kernel.onMessage = onMessage;
								return kernel;
							},
							dispose: async () => kernel.close(),
							complete: async () => ({ text: "", details: { model: "fixture", structured: false } }),
						}),
					},
				),
		],
	});
	const f = await rpcFixture(harness);
	if (!tool) throw new Error("eval not registered");
	return { ...f, kernel, notices, tool, context: fakeExtensionContext() };
}

export async function rpc(f: Pick<RpcFixture, "connection" | "chunks">, type: string, data = {}) {
	const id = crypto.randomUUID();
	await f.connection.handleInputLine(JSON.stringify({ id, type, ...data }));
	const records: Record<string, unknown>[] = f.chunks.flatMap((chunk) =>
		chunk
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	);
	const response = records.find((record) => record.id === id);
	if (!response) throw new Error(`No response for ${type}`);
	return response;
}

export async function detach(f: Fixture, id = "cell") {
	const started = f.kernel.deferNextRun();
	const execution = f.tool.execute(
		id,
		{ language: "js", code: "await work", summary: "fixture cell", timeout: 300, on_timeout: "detach" },
		undefined,
		undefined,
		f.context,
	);
	await started;
	await vi.advanceTimersByTimeAsync(60_000);
	await execution;
}

export function history(harness: Harness) {
	return {
		messages: structuredClone(harness.session.messages),
		entries: structuredClone(harness.sessionManager.getEntries()),
	};
}
