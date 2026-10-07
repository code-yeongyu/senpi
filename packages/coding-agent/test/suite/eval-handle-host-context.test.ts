import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { createEventBus } from "../../src/core/event-bus.ts";
import type { EvalHandleHost } from "../../src/core/extensions/eval-handle-host.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../../src/core/extensions/types.ts";
import type { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "../helpers/extension-session-settings.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { FakeEvalHandleHost } from "./fakes/eval-handle-host.ts";

const actions: ExtensionActions = {
	registerLazyToolActivator: () => {},
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	executeTool: async <TDetails = unknown>() => ({ content: [], details: undefined as TDetails }),
	getActiveTools: () => [],
	getAllTools: () => [],
	getSettings: () => ({}),
	setActiveTools: () => {},
	refreshTools: () => {},
	registerRemovedToolHint: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
	setSessionModel: async () => false,
	setSessionThinkingLevel: () => {},
	setSessionFastMode: () => {},
};

function contextActions(tempDir: string): ExtensionContextActions {
	return {
		getModel: () => undefined,
		getServiceTier: () => undefined,
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		isCompacting: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getMessageRevision: () => 0,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		getSystemPrompt: () => "",
		getLoadedHookSources: () => ({
			agentDir: tempDir,
			cwd: tempDir,
			globalHookSourcePaths: [],
			globalHooksPath: path.join(tempDir, "hooks.json"),
			preSessionHookSourcePaths: [],
			projectHookSourcePaths: [],
			projectHooksPath: path.join(tempDir, ".senpi", "hooks.json"),
			runtimeHookSourcePaths: [],
		}),
	};
}

describe("session-scoped EvalHandleHost provide/read pair", () => {
	let tempDir: string;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-eval-handle-host-"));
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("lets one extension provide the host and another read it through ctx, per runtime", async () => {
		// Given: a provider and a consumer extension loaded into the same session runtime.
		const host = new FakeEvalHandleHost({ ownerSessionId: "session-a" });
		const runtime = createExtensionRuntime();
		const bus = createEventBus();
		const seen: Array<EvalHandleHost | undefined> = [];
		const provider = await loadExtensionFromFactory(
			(pi) => {
				pi.on("session_start", () => {
					pi.provideEvalHandleHost(host);
				});
			},
			tempDir,
			bus,
			runtime,
			"provider.ts",
		);
		const consumer = await loadExtensionFromFactory(
			(pi) => {
				pi.on("turn_start", (_event, ctx) => {
					seen.push(ctx.evalHandleHost);
				});
			},
			tempDir,
			bus,
			runtime,
			"consumer.ts",
		);
		const runner = new ExtensionRunner(
			[provider, consumer],
			runtime,
			tempDir,
			SessionManager.inMemory(),
			modelRegistry,
		);
		runner.bindCore(actions, contextActions(tempDir));

		// When: the consumer reads before and after the provider registers.
		await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 0 });
		await runner.emit({ type: "session_start", reason: "startup" });
		await runner.emit({ type: "turn_start", turnIndex: 1, timestamp: 0 });

		// Then: absent before the provider runs, the very same object afterwards.
		expect(seen).toEqual([undefined, host]);

		// And: a second session runtime never sees the first session's host.
		const other = createExtensionRuntime();
		const otherConsumer = await loadExtensionFromFactory(() => {}, tempDir, createEventBus(), other, "other.ts");
		const otherRunner = new ExtensionRunner(
			[otherConsumer],
			other,
			tempDir,
			SessionManager.inMemory(),
			modelRegistry,
		);
		otherRunner.bindCore(actions, contextActions(tempDir));
		expect(otherRunner.createContext().evalHandleHost).toBeUndefined();
	});

	it("drops the host when the runtime is invalidated so a replaced session starts without one", async () => {
		const host = new FakeEvalHandleHost({ ownerSessionId: "session-b" });
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.on("session_start", () => {
					pi.provideEvalHandleHost(host);
				});
			},
			tempDir,
			createEventBus(),
			runtime,
			"provider.ts",
		);
		const runner = new ExtensionRunner([extension], runtime, tempDir, SessionManager.inMemory(), modelRegistry);
		runner.bindCore(actions, contextActions(tempDir));
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(runtime.evalHandleHost).toBe(host);

		runtime.invalidate();

		expect(runtime.evalHandleHost).toBeUndefined();
	});
});
