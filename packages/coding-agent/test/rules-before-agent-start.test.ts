/**
 * Regression tests for the vendored `rules` builtin extension's
 * `before_agent_start` / `tool_result` delivery behaviour.
 *
 * The host (`agent-session.ts`) calls `emitBeforeAgentStart(...)` with the BASE
 * system prompt on EVERY user prompt, so the rules block must be re-emitted on
 * every turn — while the dynamic (`tool_result`) path must keep de-duplicating
 * against rules that were already delivered statically.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import piRulesExtension from "../src/core/extensions/builtin/rules/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "./helpers/extension-session-settings.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const BASE_SYSTEM_PROMPT = "BASE SYSTEM PROMPT (rebuilt by the host on every user prompt)";
const STATIC_BLOCK_HEADING = "## Project Instructions";

describe("rules builtin - before_agent_start delivery", () => {
	let projectDir: string;
	let canaryRulePath: string;
	let canaryRuleContents: string;
	let canaryToken: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	const extensionActions: ExtensionActions = {
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

	const extensionContextActions: ExtensionContextActions = {
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
			agentDir: projectDir,
			cwd: projectDir,
			globalHookSourcePaths: [],
			globalHooksPath: join(projectDir, "hooks.json"),
			preSessionHookSourcePaths: [],
			projectHookSourcePaths: [],
			projectHooksPath: join(projectDir, ".senpi", "hooks.json"),
			runtimeHookSourcePaths: [],
		}),
	};

	/** Fresh extension instance + runner, so each scenario starts with an empty dedup cache. */
	const createRunner = async (): Promise<ExtensionRunner> => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			piRulesExtension,
			projectDir,
			createEventBus(),
			runtime,
			"<builtin:rules>",
		);
		const runner = new ExtensionRunner([extension], runtime, projectDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, extensionContextActions);
		return runner;
	};

	const textOf = (content: ReadonlyArray<{ type: string }> | undefined): string =>
		(content ?? [])
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");

	beforeEach(async () => {
		// realpath so the fixture path matches what the rule finder resolves on
		// macOS, where `os.tmpdir()` is a symlink into `/private/var`.
		projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-rules-before-agent-start-")));
		// `.git` makes `findProjectRoot` stop here (PROJECT_MARKERS).
		mkdirSync(join(projectDir, ".git"), { recursive: true });
		mkdirSync(join(projectDir, ".omo", "rules"), { recursive: true });
		canaryToken = `RULES-S8-CANARY-${randomUUID()}`;
		canaryRuleContents = `---\nalwaysApply: true\n---\n\n# Canary rule\n\n${canaryToken}\n`;
		canaryRulePath = join(projectDir, ".omo", "rules", "canary.md");
		writeFileSync(canaryRulePath, canaryRuleContents, "utf-8");

		sessionManager = SessionManager.inMemory();
		modelRegistry = await createModelRegistry(AuthStorage.create(join(projectDir, "auth.json")));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	// S8 (RED): the host rebuilds the system prompt from `this._baseSystemPrompt`
	// on every user prompt, so a rules block delivered only on the first
	// `before_agent_start` silently disappears from turn 2 onward. The block must
	// therefore be re-emitted on every invocation, not deduped away after the first.
	it("#given an alwaysApply project rule #when before_agent_start fires twice with the same base prompt #then both invocations carry the rules block", async () => {
		const runner = await createRunner();

		const first = await runner.emitBeforeAgentStart("first user prompt", undefined, BASE_SYSTEM_PROMPT, {
			cwd: projectDir,
		});
		const second = await runner.emitBeforeAgentStart("second user prompt", undefined, BASE_SYSTEM_PROMPT, {
			cwd: projectDir,
		});

		const firstPrompt = first?.systemPrompt ?? "";
		const secondPrompt = second?.systemPrompt ?? "";

		expect(firstPrompt).toContain(STATIC_BLOCK_HEADING);
		expect(firstPrompt).toContain(canaryToken);
		expect(
			secondPrompt,
			"second before_agent_start must re-inject the static rules block: the host restarts from the base system prompt on every user prompt, so a block delivered only once is absent from turn 2 onward",
		).toContain(STATIC_BLOCK_HEADING);
		expect(
			secondPrompt,
			"second before_agent_start must re-inject the canary rule body for the same reason",
		).toContain(canaryToken);
	});

	// S9: static delivery must still mark rules as injected so the dynamic
	// (tool_result) path does not append the same rule a second time.
	it("#given a rule already delivered statically #when a read tool result targets that rule file #then the dynamic path does not re-inject it", async () => {
		const runner = await createRunner();

		const staticResult = await runner.emitBeforeAgentStart("first user prompt", undefined, BASE_SYSTEM_PROMPT, {
			cwd: projectDir,
		});
		expect(staticResult?.systemPrompt ?? "").toContain(canaryToken);

		const toolResult = await runner.emitToolResult({
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-read-canary",
			input: { path: canaryRulePath },
			content: [{ type: "text", text: "<canary rule file contents elided>" }],
			details: undefined,
			isError: false,
		});

		expect(
			textOf(toolResult?.content),
			"a statically delivered rule must not be appended again by the dynamic tool_result path",
		).not.toContain(canaryToken);
	});

	// S10: rules the host already inlined as native context files must not be
	// duplicated into the system prompt by this extension.
	it("#given a rule listed in systemPromptOptions.contextFiles #when before_agent_start fires #then that rule is excluded from the injected block", async () => {
		// Baseline on a fresh engine: without contextFiles the canary IS injected,
		// so the exclusion assertion below cannot pass vacuously.
		const baselineRunner = await createRunner();
		const baseline = await baselineRunner.emitBeforeAgentStart(
			"baseline user prompt",
			undefined,
			BASE_SYSTEM_PROMPT,
			{ cwd: projectDir },
		);
		expect(baseline?.systemPrompt ?? "").toContain(canaryToken);

		const runner = await createRunner();
		const result = await runner.emitBeforeAgentStart("user prompt", undefined, BASE_SYSTEM_PROMPT, {
			cwd: projectDir,
			contextFiles: [{ path: canaryRulePath, content: canaryRuleContents }],
		});

		expect(
			result?.systemPrompt ?? "",
			"a rule already present as a native context file must not be injected again",
		).not.toContain(canaryToken);
	});
});
