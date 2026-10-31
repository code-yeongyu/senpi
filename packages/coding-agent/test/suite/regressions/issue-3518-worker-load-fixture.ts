// Runs inside a real worker isolate: opens one session through the registry a session worker
// builds and reports which SessionManager load path the open took.
import { parentPort, workerData } from "node:worker_threads";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { createSessionWorkerRegistry } from "../../../src/modes/rpc/session-worker-registry.ts";
import { fakeSessionBase } from "../../helpers/fake-session-base.ts";

const { agentDir, cwd, sessionPath } = workerData as { agentDir: string; cwd: string; sessionPath: string };
const loads: string[] = [];
const blockingOpen = SessionManager.open;
const slicedOpen = SessionManager.openAsync;
SessionManager.open = (...args: Parameters<typeof blockingOpen>) => {
	loads.push("blocking");
	return blockingOpen.apply(SessionManager, args);
};
SessionManager.openAsync = (...args: Parameters<typeof slicedOpen>) => {
	loads.push("sliced");
	return slicedOpen.apply(SessionManager, args);
};

const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
	new ProjectTrustStore(options.agentDir).set(options.cwd, true);
	return {
		session: {
			...fakeSessionBase(options),
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

const registry = createSessionWorkerRegistry(agentDir, createRuntime);
const opened = await registry.openSession({ cwd, sessionPath, permissionPreset: "default" });
await registry.close(opened.sessionId);
parentPort?.postMessage({ loads, durableSessionId: opened.durableSessionId });
