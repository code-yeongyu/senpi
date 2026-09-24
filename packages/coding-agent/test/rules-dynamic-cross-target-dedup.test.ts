import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import piRulesExtension from "../src/core/extensions/builtin/rules/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions, SessionCompactEvent } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getTextOutput } from "../src/core/tools/render-utils.ts";
import { createInMemoryExtensionSessionSettings } from "./helpers/extension-session-settings.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const RULE_PATH = ".omo/rules/shared.md";

interface AppendedEntry {
	readonly customType: string;
	readonly data: unknown;
}

describe("rules dynamic cross-target dedup", () => {
	let projectDir: string;
	let rulePath: string;
	let ruleToken: string;
	let firstTarget: string;
	let secondTarget: string;
	let appendedEntries: AppendedEntry[];
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	const actions: ExtensionActions = {
		registerLazyToolActivator: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: (customType, data) => appendedEntries.push({ customType, data }),
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

	const contextActions: ExtensionContextActions = {
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
		runner.bindCore(actions, contextActions);
		return runner;
	};

	const readResult = (runner: ExtensionRunner, path: string, toolCallId = `call-${randomUUID()}`) =>
		runner.emitToolResult({
			type: "tool_result",
			toolName: "read",
			toolCallId,
			input: { path },
			content: [{ type: "text", text: "<file contents>" }],
			details: undefined,
			isError: false,
		});

	const textOf = (content: ReadonlyArray<{ type: string }> | undefined): string =>
		(content ?? [])
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n");

	const activationCount = (): number =>
		appendedEntries.filter((entry) => {
			if (entry.customType !== "rule-activation" || typeof entry.data !== "object" || entry.data === null) {
				return false;
			}
			const rules = Reflect.get(entry.data, "rules");
			return Array.isArray(rules) && rules.includes(RULE_PATH);
		}).length;

	beforeEach(async () => {
		projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), "rules-dynamic-dedup-")));
		mkdirSync(join(projectDir, ".git"), { recursive: true });
		mkdirSync(join(projectDir, ".omo", "rules"), { recursive: true });
		ruleToken = `DYNAMIC-RULE-${randomUUID()}`;
		rulePath = join(projectDir, RULE_PATH);
		writeFileSync(rulePath, ruleContents(ruleToken), "utf-8");
		firstTarget = join(projectDir, "fig-001.ts");
		secondTarget = join(projectDir, "fig-002.ts");
		writeFileSync(firstTarget, "export const first = true;\n", "utf-8");
		writeFileSync(secondTarget, "export const second = true;\n", "utf-8");
		appendedEntries = [];
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createModelRegistry(AuthStorage.create(join(projectDir, "auth.json")));
	});

	afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

	it("injects one unchanged rule across two distinct matching targets", async () => {
		const runner = await createRunner();

		const firstResult = await readResult(runner, firstTarget);
		expect(textOf(firstResult?.content)).toContain(ruleToken);
		// #2041: the body stays visible; the appended instruction is model-only.
		expect(firstResult?.content).toEqual([
			{ type: "text", text: "<file contents>" },
			{ type: "text", text: expect.stringContaining(ruleToken), audience: "model" },
		]);
		expect(textOf((await readResult(runner, secondTarget))?.content)).not.toContain(ruleToken);
		expect(activationCount()).toBe(1);
	});

	// senpi#2057: the notice names the read it was injected into, so the TUI can fold it into that read's group.
	it("records the triggering tool call id on the project-rules activation", async () => {
		const runner = await createRunner();

		await readResult(runner, firstTarget, "call-read-first");

		expect(appendedEntries.filter((entry) => entry.customType === "rule-activation")).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({ kind: "project-rules", toolCallId: "call-read-first" }),
			}),
		]);
	});

	it("keeps suppression after rejected compaction and resets it after accepted compaction", async () => {
		const runner = await createRunner();

		expect(textOf((await readResult(runner, firstTarget))?.content)).toContain(ruleToken);
		await runner.emit({
			type: "session_compact",
			reason: "manual",
			requestId: "rejected-compaction",
			accepted: false,
			rejectionCause: "cancelled-by-extension",
			fromExtension: false,
			willRetry: false,
		} satisfies SessionCompactEvent);
		expect(textOf((await readResult(runner, secondTarget))?.content)).not.toContain(ruleToken);
		expect(activationCount()).toBe(1);

		await runner.emit({
			type: "session_compact",
			reason: "manual",
			requestId: "accepted-compaction",
			accepted: true,
			fromExtension: false,
			willRetry: false,
			compactionEntry: {
				type: "compaction",
				id: "compaction-entry",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				summary: "compacted",
				firstKeptEntryId: "kept-entry",
				tokensBefore: 100,
			},
		} satisfies SessionCompactEvent);
		expect(textOf((await readResult(runner, secondTarget))?.content)).toContain(ruleToken);
		expect(activationCount()).toBe(2);
	});

	it("keeps a truncated-rule continuation inside the model-only part (#2041)", async () => {
		writeFileSync(rulePath, ruleContents(`${ruleToken}\n${"rule text\n".repeat(2000)}`), "utf-8");
		const runner = await createRunner();
		const result = await readResult(runner, firstTarget);
		if (!result?.content) throw new Error("Expected injected rule content");
		expect(result.content.at(-1)).toMatchObject({
			type: "text",
			audience: "model",
			text: expect.stringContaining("[Rule truncated. Read full rule:"),
		});
		expect(getTextOutput({ content: result.content }, false)).toBe("<file contents>");
	});

	it("re-injects when rule content changes before compaction", async () => {
		const runner = await createRunner();
		expect(textOf((await readResult(runner, firstTarget))?.content)).toContain(ruleToken);

		const updatedToken = `UPDATED-RULE-${randomUUID()}`;
		writeFileSync(rulePath, ruleContents(updatedToken), "utf-8");
		const future = new Date(Date.now() + 10_000);
		utimesSync(rulePath, future, future);

		const updatedResult = textOf((await readResult(runner, secondTarget))?.content);
		expect(updatedResult).toContain(updatedToken);
		expect(updatedResult).not.toContain(ruleToken);
		expect(activationCount()).toBe(2);
	});
});

function ruleContents(token: string): string {
	return `---\nglobs: "**/*.ts"\n---\n\n# Shared rule\n\n${token}\n`;
}
