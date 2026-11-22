import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import piRulesExtension from "../src/core/extensions/builtin/rules/index.ts";
import { TRUNCATION_NOTICE } from "../src/core/extensions/builtin/rules/rules/constants.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "./helpers/extension-session-settings.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const BASE_SYSTEM_PROMPT = "BASE SYSTEM PROMPT";
const ENV_KEYS = ["PI_RULES_DISABLED", "PI_RULES_MAX_RULE_CHARS", "PI_RULES_MAX_RESULT_CHARS"] as const;
const STATIC_RULE_PATH = "AGENTS.md";
const STATIC_BODY = "x".repeat(5000);
const DYNAMIC_TOKEN = "DYNAMIC-RULE-TOKEN";

describe("rules builtin - environment configuration", () => {
	let projectDir: string;
	let targetPath: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let savedHome: string | undefined;
	const savedEnv = new Map<(typeof ENV_KEYS)[number], string | undefined>();

	const extensionActions: ExtensionActions = {
		registerLazyToolActivator: () => {},
		getSettings: () => ({}),
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

	const emitStatic = async (runner?: ExtensionRunner): Promise<string> => {
		const activeRunner = runner ?? (await createRunner());
		const result = await activeRunner.emitBeforeAgentStart("user prompt", undefined, BASE_SYSTEM_PROMPT, {
			cwd: projectDir,
		});
		return result?.systemPrompt ?? "";
	};

	const emitDynamic = async (runner?: ExtensionRunner): Promise<string> => {
		const activeRunner = runner ?? (await createRunner());
		const result = await activeRunner.emitToolResult({
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-read-target",
			input: { path: targetPath },
			content: [{ type: "text", text: "target contents" }],
			details: { filePath: targetPath },
			isError: false,
		});
		const appended = result?.content?.at(-1);
		return appended?.type === "text" ? appended.text : "";
	};

	const staticBodyRunLength = (prompt: string): number =>
		Math.max(0, ...(prompt.match(/x+/g) ?? []).map((run) => run.length));

	const staticRulePayload = (prompt: string): string => {
		const header = `Instructions from: ${join(projectDir, STATIC_RULE_PATH)}\n`;
		const start = prompt.indexOf(header);
		if (start < 0) return "";
		const bodyStart = start + header.length;
		const bodyEnd = prompt.indexOf("\n</project_rules>", bodyStart);
		return bodyEnd < 0 ? prompt.slice(bodyStart) : prompt.slice(bodyStart, bodyEnd);
	};

	beforeEach(async () => {
		savedEnv.clear();
		for (const key of ENV_KEYS) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}

		projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), "senpi-rules-env-")));
		savedHome = process.env.HOME;
		process.env.HOME = join(projectDir, "home");
		mkdirSync(process.env.HOME, { recursive: true });
		mkdirSync(join(projectDir, ".git"), { recursive: true });
		mkdirSync(join(projectDir, ".omo", "rules"), { recursive: true });
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, STATIC_RULE_PATH), STATIC_BODY, "utf-8");
		writeFileSync(
			join(projectDir, ".omo", "rules", "dynamic.md"),
			`---\nglobs: "src/**/*.ts"\n---\n${DYNAMIC_TOKEN}`,
			"utf-8",
		);
		const writtenTargetPath = join(projectDir, "src", "index.ts");
		writeFileSync(writtenTargetPath, "export const value = 1;\n", "utf-8");
		targetPath = realpathSync.native(writtenTargetPath);
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createModelRegistry(AuthStorage.create(join(projectDir, "auth.json")));
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		for (const key of ENV_KEYS) {
			const value = savedEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("disables static injection for every documented truthy value", async () => {
		for (const value of ["1", "true", "yes", "on", " TRUE "]) {
			process.env.PI_RULES_DISABLED = value;
			expect(await emitStatic()).toBe("");
		}
	});

	it("disables dynamic injection without a vacuous target", async () => {
		expect(await emitDynamic()).toContain(DYNAMIC_TOKEN);
		process.env.PI_RULES_DISABLED = "1";
		expect(await emitDynamic()).toBe("");
	});

	it("keeps non-truthy disabled values enabled", async () => {
		for (const value of ["0", "false", "off", "maybe", ""]) {
			process.env.PI_RULES_DISABLED = value;
			expect(await emitStatic()).toContain(STATIC_BODY);
		}
	});

	it("keeps the presence-only disabled flag working", async () => {
		const runner = await createRunner();
		runner.setFlagValue("pi-rules-disabled", true);
		expect(await emitStatic(runner)).toBe("");
	});

	it("caps each rule body and accepts surrounding whitespace", async () => {
		for (const value of ["50", " 50 "]) {
			process.env.PI_RULES_MAX_RULE_CHARS = value;
			const prompt = await emitStatic();
			expect(staticRulePayload(prompt)).toHaveLength(50);
			expect(prompt).toContain(TRUNCATION_NOTICE.replace("{path}", STATIC_RULE_PATH));
		}
	});

	it("caps the total injected result independently", async () => {
		process.env.PI_RULES_MAX_RESULT_CHARS = "300";
		const prompt = await emitStatic();
		const block = prompt.slice(BASE_SYSTEM_PROMPT.length);
		expect(block.length).toBeLessThanOrEqual(300);
		expect(staticBodyRunLength(prompt)).toBeLessThan(STATIC_BODY.length);
		expect(prompt).toContain(TRUNCATION_NOTICE.replace("{path}", STATIC_RULE_PATH));
	});

	it("caps the complete dynamic tool-result block", async () => {
		process.env.PI_RULES_MAX_RESULT_CHARS = "600";
		const block = await emitDynamic();
		expect(block.length).toBeLessThanOrEqual(600);
		expect(block).toContain("Additional project instructions matched for src/index.ts:");
	});

	it("preserves defaults for malformed or unsafe numeric values", async () => {
		const values = ["", "   ", "0", "-5", "50abc", "1.5", "1e3", "0x10", "+50", "٥٠", "99999999999999999999"];
		for (const value of values) {
			process.env.PI_RULES_MAX_RULE_CHARS = value;
			process.env.PI_RULES_MAX_RESULT_CHARS = value;
			const prompt = await emitStatic();
			expect(staticRulePayload(prompt)).toHaveLength(STATIC_BODY.length);
			expect(prompt).not.toContain(TRUNCATION_NOTICE.replace("{path}", STATIC_RULE_PATH));
		}
	});
});
