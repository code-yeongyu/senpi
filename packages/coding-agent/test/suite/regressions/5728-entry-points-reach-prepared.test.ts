// senpi#5728 (S36, plan amendment A4): every shipped entry point builds its session through
// createAgentSessionRuntime -> createAgentSessionFromServices -> createAgentSession, and must run model-issued tool
// calls on the prepared pipeline on default config, with no batch-store argument anywhere.
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type AgentSessionRuntime, createAgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { type Cleanups, preparedCall, productionFactory, type Witnessed, watch } from "./5728-entry-fixture.ts";

const rpcIo = vi.hoisted(() => ({ lineHandler: undefined as ((line: string) => void) | undefined }));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: vi.fn(),
}));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const cleanups: Cleanups = [];
const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];

function keepProcessListeners(): void {
	const stdinEnd = process.stdin.listeners("end");
	const before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
	cleanups.push(() => {
		for (const listener of process.stdin.listeners("end"))
			if (!stdinEnd.includes(listener)) process.stdin.off("end", listener);
		for (const [signal, previous] of before)
			for (const listener of process.listeners(signal))
				if (!previous.includes(listener)) process.off(signal, listener);
	});
}
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function defaultRuntime(): Promise<{ runtime: AgentSessionRuntime } & Witnessed> {
	const { dir, createRuntime } = await productionFactory(cleanups);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: dir,
		agentDir: dir,
		sessionManager: SessionManager.inMemory(dir),
	});
	await runtime.session.bindExtensions({});
	cleanups.push(() => runtime.dispose());
	return { runtime, ...watch(runtime) };
}

it("the session runtime every mode and the RPC host build (createAgentSessionRuntime) runs on the prepared pipeline", async () => {
	const { runtime, witnesses } = await defaultRuntime();
	await runtime.session.prompt("go");
	expect(witnesses).toEqual(preparedCall);
	expect(runtime.session.messages.find((m) => m.role === "toolResult")?.isError).toBe(false);
});

it("print mode driving that runtime runs on the prepared pipeline", async () => {
	const { runtime, witnesses } = await defaultRuntime();
	const exitCode = await runPrintMode(runtime, { mode: "text", initialMessage: "go" });
	expect(exitCode).toBe(0);
	expect(witnesses).toEqual(preparedCall);
});

it("RPC mode driving that runtime runs on the prepared pipeline", async () => {
	keepProcessListeners();
	const { runtime, witnesses, witnessed } = await defaultRuntime();
	void runRpcMode(runtime);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	rpcIo.lineHandler?.(JSON.stringify({ id: "p1", type: "prompt", message: "go" }));
	await witnessed;
	expect(witnesses).toEqual(preparedCall);
});

it("the shared RPC host (multi-session, the desktop engine's host) opens sessions that run on the prepared pipeline", async () => {
	const { dir, createRuntime } = await productionFactory(cleanups);
	new ProjectTrustStore(dir).set(dir, true);
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime });
	const opened = await registry.openSession({ cwd: dir, sessionPath: join(dir, "host-session.jsonl") });
	cleanups.push(() => registry.close(opened.sessionId));
	const { runtime } = registry.getForCommand(opened.sessionId, "prompt");
	if (runtime === undefined) throw new Error("the host opened no runtime");
	const { witnesses, witnessed } = watch(runtime);
	await runtime.session.bindExtensions({});
	await runtime.session.prompt("go");
	await witnessed;
	expect(witnesses).toEqual(preparedCall);
});
