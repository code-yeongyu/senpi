import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { type RpcSessionLaunchProfile, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

// senpi#1905: at the close grace deadline the registry used to fire runtime disposal
// and scope.close() back to back. A disposal still running (a slow session_shutdown
// handler) then executed inside a CLOSED provider scope: its bound callbacks threw
// "Provider scope is closed", the watchers it was about to close leaked, and the
// dead session kept firing from its debounce timers.

const profile = (cwd: string, sessionPath: string): RpcSessionLaunchProfile => ({
	cwd,
	sessionPath,
	permissionPreset: "default",
	creationModel: { provider: "test", modelId: "model" },
	initialThinkingLevel: "high",
});

// Runtime disposal is `session_shutdown` emission (the slow part: extension handlers)
// followed by a synchronous `AgentSession.dispose()`, so the slow handler is where the
// disposal's lifetime is modelled.
function runtime(
	options: Parameters<CreateAgentSessionRuntimeFactory>[0],
	onSessionShutdown: () => Promise<void>,
): CreateAgentSessionRuntimeResult {
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
			extensionRunner: {
				hasHandlers: () => true,
				emit: async (event: { readonly type: string }) => {
					if (event.type === "session_shutdown") await onSessionShutdown();
				},
			},
			// A hung abort forces the grace-deadline path.
			abort: () => new Promise<void>(() => {}),
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

describe("issue 1905: provider scope closes after runtime disposal", () => {
	const directories: string[] = [];
	afterEach(async () => {
		await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("keeps the scope open while a slow disposal is still running at the grace deadline", async () => {
		// Given: a session whose abort hangs and whose session_shutdown handler settles only when released
		const dir = await mkdtemp(join(tmpdir(), "senpi-1905-teardown-"));
		directories.push(dir);
		const order: string[] = [];
		let releaseDispose: (() => void) | undefined;
		const disposing = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			closeGraceMs: 50,
			createRuntime: async (options) =>
				runtime(options, async () => {
					order.push("dispose:start");
					await disposing;
					order.push("dispose:settled");
				}),
		});
		const opened = await registry.openSession(profile(dir, join(dir, "slow-dispose.jsonl")));
		const entry = registry.peek(opened.sessionId);
		if (!entry) throw new Error("session was not opened");
		let scopeClosed: (() => void) | undefined;
		const scopeClosedSignal = new Promise<void>((resolve) => {
			scopeClosed = resolve;
		});
		entry.scope.close = () => {
			order.push("scope:closed");
			scopeClosed?.();
		};

		// When: the close hits its grace deadline while disposal is still pending
		await registry.close(opened.sessionId);

		// Then: the path is released but the scope is still open for the running disposal
		expect(registry.list()).toEqual([]);
		expect(order).toEqual(["dispose:start"]);

		// When: the disposal settles
		releaseDispose?.();
		await scopeClosedSignal;

		// Then: the scope closes strictly after it
		expect(order).toEqual(["dispose:start", "dispose:settled", "scope:closed"]);
	});
});
