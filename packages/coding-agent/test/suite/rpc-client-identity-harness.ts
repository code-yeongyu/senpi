import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type HarnessOptions } from "./harness.ts";
import { makeSink } from "./rpc-connection-harness.ts";

export async function createIdentityHarness(options: HarnessOptions = {}) {
	const harness = await createHarness({ ...options, persistSession: true, autoTitleSessions: false });
	let session = harness.session;
	// harness.cleanup() disposes the original session; every session opened here is disposed here, once.
	const opened: AgentSession[] = [];
	let request = 0;
	const connections: ReturnType<typeof createRpcConnectionHandler>[] = [];
	const runtimes: AgentSessionRuntime[] = [];
	const bind = () => {
		const collected = makeSink();
		const runtime = new AgentSessionRuntime(
			session,
			{
				cwd: harness.tempDir,
				agentDir: session.agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.modelRegistry,
				modelRuntime: session.modelRuntime,
				settingsManager: harness.settingsManager,
				resourceLoader: session.resourceLoader,
				diagnostics: [],
			},
			async () => {
				throw new Error("This fixture does not replace sessions through RPC");
			},
		);
		runtimes.push(runtime);
		const handler = createRpcConnectionHandler(runtime, collected.sink, {
			disposeRuntime: false,
			eventFlushScheduler: (flush) => flush(),
		});
		connections.push(handler);
		return {
			...collected,
			handler,
			async send(command: object) {
				const id = `transport-${++request}`;
				const response = collected.waitFor((record) => record.id === id, 15_000);
				await handler.handleInputLine(JSON.stringify({ ...command, id }));
				return response;
			},
		};
	};
	const openSession = (): AgentSession => {
		const path = harness.sessionManager.getSessionFile();
		if (!path) throw new Error("The persistent fixture has no session file");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: harness.getModel(), systemPrompt: "Test", tools: [] },
				streamFn: harness.agent.streamFunction,
				getApiKey: () => "faux-key",
			}),
			sessionManager: SessionManager.open(path),
			settingsManager: harness.settingsManager,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: harness.session.resourceLoader,
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
		});
		opened.push(session);
		return session;
	};
	const detach = async (): Promise<void> => {
		for (const connection of connections.splice(0)) await connection.dispose();
		for (const runtime of runtimes.splice(0)) runtime.releaseSessionHold();
	};
	return {
		harness,
		get session() {
			return session;
		},
		bind,
		async openSettled() {
			await session.waitForIdle();
			await detach();
			return openSession();
		},
		async reopen() {
			await this.openSettled();
			return bind();
		},
		/**
		 * Open the transcript in a new bound session while the current one is left mid-run,
		 * as a restarted host finds the file after the previous process died.
		 */
		async reopenAbandoned() {
			await detach();
			openSession();
			return bind();
		},
		async cleanup() {
			const aborts = await Promise.allSettled([harness.session, ...opened].map((each) => each.abort()));
			try {
				await detach();
			} finally {
				for (const each of opened) each.dispose();
				harness.cleanup();
			}
			const failed = aborts.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		},
	};
}
