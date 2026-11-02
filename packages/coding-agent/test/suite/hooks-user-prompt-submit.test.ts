import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { buildUserPromptHookInput } from "../../src/core/extensions/builtin/hooks/prompt-adapter.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText } from "./harness.ts";

const createdDirs: string[] = [];

function hooksExtensionFactory() {
	const extension = builtinExtensions.find((entry) => entry.id === "hooks");
	if (extension === undefined) {
		throw new Error("builtin hooks extension is not registered");
	}
	return extension.factory;
}

function createTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	return dir;
}

function writeHookProject(cwd: string, command: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const sourcePath = join(senpiDir, "hooks.json");
	const hookConfig = {
		hooks: {
			UserPromptSubmit: [
				{
					hooks: [
						{
							type: "command",
							command,
						},
					],
				},
			],
		},
	};
	writeFileSync(sourcePath, `${JSON.stringify(hookConfig, null, 2)}\n`, "utf-8");

	const source = {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	} satisfies HookSourceMetadata;
	const parsed = parseHookConfig(hookConfig, source);
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of parsed.executableHandlers) {
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-06-29T00:00:00.000Z",
		});
	}
	writeFileSync(join(senpiDir, "hooks-state.json"), `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`, "utf-8");
}

function createHooksHarness(options: Parameters<typeof createHarness>[0] = {}) {
	return createHarness({
		extensionFactories: [{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" }],
		...options,
	});
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks UserPromptSubmit adapter", () => {
	it("adds transcript_path only when a stable session file is available", () => {
		// Given / When
		const withoutTranscript = buildUserPromptHookInput({
			cwd: "/repo",
			permissionMode: "default",
			prompt: "hello",
			sessionId: "session-1",
		});
		const withTranscript = buildUserPromptHookInput({
			cwd: "/repo",
			permissionMode: "workspace",
			prompt: "hello",
			sessionId: "session-1",
			transcriptPath: "/repo/.senpi/session.jsonl",
		});

		// Then
		expect(withoutTranscript).not.toHaveProperty("transcript_path");
		expect(withTranscript).toMatchObject({
			permission_mode: "workspace",
			session_id: "session-1",
			transcript_path: "/repo/.senpi/session.jsonl",
		});
	});

	it("handles blocked prompts with a warning/custom message and no model turn", async () => {
		// Given
		const hookDir = createTempDir("senpi-user-prompt-block-hook");
		const stdinPath = join(hookDir, "stdin.json");
		const scriptPath = join(hookDir, "block.mjs");
		writeFileSync(
			scriptPath,
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(stdinPath)}, stdin); process.stdout.write(JSON.stringify({ decision: 'block', reason: 'ticket required' })); });`,
			"utf-8",
		);
		const harness = await createHooksHarness();
		writeHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([fauxAssistantMessage("model should not run")]);

		try {
			// When
			await harness.session.prompt("ship it");

			// Then
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
			const customMessages = harness.session.messages.filter((message) => message.role === "custom");
			expect(customMessages).toHaveLength(1);
			expect(customMessages[0]).toMatchObject({
				customType: "senpi.hook",
				display: false,
			});
			expect(getMessageText(customMessages[0])).toContain("ticket required");
			const stdin: unknown = JSON.parse(readFileSync(stdinPath, "utf-8"));
			expect(stdin).toMatchObject({
				cwd: harness.tempDir,
				event: "UserPromptSubmit",
				permission_mode: "default",
				prompt: "ship it",
				session_id: harness.session.sessionId,
			});
			expect(stdin).not.toHaveProperty("transcript_path");
		} finally {
			harness.cleanup();
		}
	});

	it("injects hook context after real skill expansion changes the prompt", async () => {
		// Given
		const hookDir = createTempDir("senpi-user-prompt-context-hook");
		const scriptPath = join(hookDir, "context.mjs");
		const skillPath = join(hookDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the real expanded skill body.", "utf-8");
		writeFileSync(
			scriptPath,
			"process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ systemMessage: 'Use the project diagnostic.', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Context from hook only.', prompt: 'REPLACED PROMPT MUST NOT APPEAR' } })); });",
			"utf-8",
		);
		const extensionsResult = await createTestExtensionsResult(
			[{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" }],
			hookDir,
		);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						baseDir: hookDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: hookDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		writeHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([fauxAssistantMessage("ok")]);

		try {
			// When
			await harness.session.prompt("/skill:test original prompt");

			// Then
			const userMessages = harness.session.messages.filter((message) => message.role === "user");
			expect(userMessages).toHaveLength(1);
			expect(getMessageText(userMessages[0])).toContain('<skill-instruction name="test" location="');
			expect(getMessageText(userMessages[0])).toContain("Use the real expanded skill body.");
			expect(getMessageText(userMessages[0])).toContain("original prompt");
			expect(getMessageText(userMessages[0])).not.toContain("REPLACED PROMPT");
			const customMessageText = harness.session.messages
				.filter((message) => message.role === "custom")
				.map((message) => getMessageText(message))
				.join("\n");
			expect(customMessageText).toContain("Context from hook only.");
			expect(customMessageText).not.toContain("REPLACED PROMPT");
			expect(harness.session.systemPrompt).toContain("Use the project diagnostic.");
			expect(harness.session.systemPrompt).not.toContain("REPLACED PROMPT");
		} finally {
			harness.cleanup();
		}
	});

	it("does not replay queued context after an unrelated preflight failure", async () => {
		// Given
		const hookDir = createTempDir("senpi-user-prompt-stale-context-hook");
		const scriptPath = join(hookDir, "context-on-first.mjs");
		writeFileSync(
			scriptPath,
			"let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { const input = JSON.parse(stdin); const output = input.prompt === 'first prompt' ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'FIRST PROMPT CONTEXT' } } : {}; process.stdout.write(JSON.stringify(output)); });",
			"utf-8",
		);
		const harness = await createHooksHarness({
			withConfiguredAuth: false,
		});
		writeHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);

		try {
			// When
			await expect(harness.session.prompt("first prompt")).rejects.toThrow("No API key found");
			const model = harness.getModel();
			harness.authStorage.setRuntimeApiKey(model.provider, "faux-key");
			harness.session.modelRegistry.registerProvider(model.provider, {
				api: harness.faux.api,
				apiKey: "faux-key",
				baseUrl: model.baseUrl,
				models: harness.faux.models,
			});
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("second prompt");

			// Then
			const modelVisibleMessages = harness.session.messages.filter(
				(message) => message.role === "user" || message.role === "custom",
			);
			expect(modelVisibleMessages.map((message) => getMessageText(message)).join("\n")).not.toContain(
				"FIRST PROMPT CONTEXT",
			);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("does not expose raw command failure stderr as a prompt block message", async () => {
		// Given
		const hookDir = createTempDir("senpi-user-prompt-secret-stderr-hook");
		const scriptPath = join(hookDir, "stderr-secret.mjs");
		writeFileSync(
			scriptPath,
			"process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('SECRET_TOKEN=abc123'); process.exit(2); });",
			"utf-8",
		);
		const harness = await createHooksHarness();
		writeHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([fauxAssistantMessage("model should not run")]);

		try {
			// When
			await harness.session.prompt("ship it");

			// Then
			expect(harness.getPendingResponseCount()).toBe(1);
			const modelVisiblePayload = JSON.stringify(
				harness.session.messages.filter((message) => message.role === "user" || message.role === "custom"),
			);
			expect(modelVisiblePayload).not.toContain("SECRET_TOKEN=abc123");
			const customMessages = harness.session.messages.filter((message) => message.role === "custom");
			expect(customMessages).toHaveLength(1);
			expect(getMessageText(customMessages[0])).toBe("UserPromptSubmit hook blocked the prompt.");
		} finally {
			harness.cleanup();
		}
	});
});
