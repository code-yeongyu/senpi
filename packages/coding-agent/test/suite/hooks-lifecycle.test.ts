import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type {
	HookSourceMetadata,
	HookSourceScope,
	HookTrustEntry,
	SupportedHookEvent,
} from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionFactory, ResourceLoader } from "../../src/index.ts";
import { assistantMsg, createTestExtensionsResult, createTestResourceLoader, userMsg } from "../utilities.ts";
import { createHarness, getMessageText } from "./harness.ts";

const createdDirs: string[] = [];

type HookGroup = {
	readonly matcher?: string;
	readonly commands: readonly string[];
};

type HookProject = Partial<Record<SupportedHookEvent, readonly HookGroup[]>>;

function hooksExtensionFactory(): ExtensionFactory {
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

function writeHookSource(cwd: string, sourcePath: string, scope: HookSourceScope, project: HookProject): void {
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	mkdirSync(join(cwd, "agent"), { recursive: true });
	mkdirSync(join(sourcePath, ".."), { recursive: true });

	const hooks = Object.fromEntries(
		Object.entries(project).map(([event, groups]) => [
			event,
			groups.map((group) => ({
				...(group.matcher === undefined ? {} : { matcher: group.matcher }),
				hooks: group.commands.map((command) => ({ type: "command", command })),
			})),
		]),
	);
	const hookConfig = { hooks };
	writeFileSync(sourcePath, `${JSON.stringify(hookConfig, null, 2)}\n`, "utf-8");

	const source = {
		discoveredAt: scope === "runtime" ? "runtime" : "pre-session",
		displayOrder: 0,
		scope,
		sourcePath,
	} satisfies HookSourceMetadata;
	const parsed = parseHookConfig(hookConfig, source);
	const hooksState: Record<string, HookTrustEntry> = {};
	for (const handler of parsed.executableHandlers) {
		hooksState[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-06-29T00:00:00.000Z",
		});
	}
	const statePath =
		scope === "project" ? join(cwd, ".senpi", "hooks-state.json") : join(cwd, "agent", "hooks-state.json");
	writeFileSync(statePath, `${JSON.stringify({ version: 1, hooks: hooksState }, null, 2)}\n`, "utf-8");
}

function writeProjectHooks(cwd: string, project: HookProject): string {
	const sourcePath = join(cwd, ".senpi", "hooks.json");
	writeHookSource(cwd, sourcePath, "project", project);
	return sourcePath;
}

function writeRuntimeHooks(cwd: string, sourcePath: string, project: HookProject): void {
	writeHookSource(cwd, sourcePath, "runtime", project);
}

function createNodeScript(dir: string, name: string, body: string): string {
	const scriptPath = join(dir, name);
	writeFileSync(scriptPath, body, "utf-8");
	return scriptPath;
}

function seedCompactableSession(harness: Awaited<ReturnType<typeof createHarness>>): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	harness.sessionManager.appendMessage(userMsg("message to compact"));
	harness.sessionManager.appendMessage(assistantMsg("assistant response to compact"));
	harness.sessionManager.appendMessage(userMsg("message to keep"));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function extensionProvidedCompaction(): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "summary from extension",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
	};
}

function extensionEchoesCompactionInstructions(): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: `instructions:${event.customInstructions ?? ""}`,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
	};
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks lifecycle adapters", () => {
	it("dispatches initial SessionStart only from pre-session hook sources with startup reason", async () => {
		// Given
		const loaderCwd = createTempDir("senpi-hooks-session-start-loader");
		const preSessionInputPath = join(loaderCwd, "pre-session-input.json");
		const runtimeInputPath = join(loaderCwd, "runtime-input.json");
		const preSessionScript = createNodeScript(
			loaderCwd,
			"session-start-pre.mjs",
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(preSessionInputPath)}, stdin); });`,
		);
		const runtimeScript = createNodeScript(
			loaderCwd,
			"session-start-runtime.mjs",
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(runtimeInputPath)}, stdin); });`,
		);
		const runtimeHookPath = join(loaderCwd, "runtime-hooks.json");
		let activeCwd = "";
		let runtimeHookPaths: string[] = [];
		const discoverRuntimeHooks: ExtensionFactory = (pi) => {
			pi.on("resources_discover", () => ({ hookPaths: [runtimeHookPath] }));
		};
		const extensionsResult = await createTestExtensionsResult(
			[
				{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" },
				{ factory: discoverRuntimeHooks, path: "<test:runtime-hooks>" },
			],
			loaderCwd,
		);
		const baseLoader = createTestResourceLoader({ extensionsResult });
		const resourceLoader: ResourceLoader = {
			...baseLoader,
			extendResources(resources) {
				runtimeHookPaths = (resources.hookPaths ?? []).map((entry) => resolve(entry.path));
			},
			getLoadedHookSources: () => ({
				agentDir: join(activeCwd, "agent"),
				cwd: activeCwd,
				globalHookSourcePaths: [],
				globalHooksPath: join(activeCwd, "agent", "hooks.json"),
				globalSettingsHooks: undefined,
				preSessionHookSourcePaths: [],
				projectHookSourcePaths: [],
				projectHooksPath: join(activeCwd, ".senpi", "hooks.json"),
				projectSettingsHooks: undefined,
				runtimeHookSourcePaths: runtimeHookPaths,
			}),
		};
		const harness = await createHarness({ resourceLoader });
		activeCwd = harness.tempDir;
		writeProjectHooks(harness.tempDir, {
			SessionStart: [{ matcher: "startup", commands: [`${process.execPath} ${preSessionScript}`] }],
		});
		writeRuntimeHooks(harness.tempDir, runtimeHookPath, {
			SessionStart: [{ matcher: "startup", commands: [`${process.execPath} ${runtimeScript}`] }],
		});
		runtimeHookPaths = [resolve(runtimeHookPath)];

		try {
			// When
			await harness.session.bindExtensions({ shutdownHandler: () => {} });

			// Then
			const stdin: unknown = JSON.parse(readFileSync(preSessionInputPath, "utf-8"));
			expect(stdin).toMatchObject({
				cwd: harness.tempDir,
				event: "SessionStart",
				hook_event_name: "SessionStart",
				reason: "startup",
				session_id: harness.session.sessionId,
			});
			expect(runtimeHookPaths).toEqual([resolve(runtimeHookPath)]);
			expect(() => readFileSync(runtimeInputPath, "utf-8")).toThrow();
		} finally {
			harness.cleanup();
		}
	});

	it("cancels manual PreCompact through a reason matcher without running auto matchers", async () => {
		// Given
		const hookDir = createTempDir("senpi-hooks-precompact-cancel");
		const manualInputPath = join(hookDir, "manual-input.json");
		const autoInputPath = join(hookDir, "auto-input.json");
		const cancelledPostInputPath = join(hookDir, "cancelled-post-input.json");
		const manualScript = createNodeScript(
			hookDir,
			"precompact-manual.mjs",
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(manualInputPath)}, stdin); process.stdout.write(JSON.stringify({ decision: 'block', reason: 'manual compaction paused by hook', hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: 'diagnostic only', customInstructions: 'must not apply' } })); });`,
		);
		const autoScript = createNodeScript(
			hookDir,
			"precompact-auto.mjs",
			`import { writeFileSync } from 'node:fs'; process.stdin.on('data', (chunk) => writeFileSync(${JSON.stringify(autoInputPath)}, chunk));`,
		);
		const cancelledPostScript = createNodeScript(
			hookDir,
			"postcompact-cancelled.mjs",
			`import { writeFileSync } from 'node:fs'; process.stdin.on('data', (chunk) => writeFileSync(${JSON.stringify(cancelledPostInputPath)}, chunk));`,
		);
		const harness = await createHarness({
			extensionFactories: [
				{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" },
				{ factory: extensionProvidedCompaction(), path: "<test:compaction>" },
			],
		});
		writeProjectHooks(harness.tempDir, {
			PreCompact: [
				{ matcher: "manual", commands: [`${process.execPath} ${manualScript}`] },
				{ matcher: "threshold", commands: [`${process.execPath} ${autoScript}`] },
			],
			PostCompact: [{ matcher: "manual", commands: [`${process.execPath} ${cancelledPostScript}`] }],
		});
		seedCompactableSession(harness);

		try {
			// When / Then
			await expect(harness.session.compact("original instructions")).rejects.toThrow("Compaction cancelled");
			const stdin: unknown = JSON.parse(readFileSync(manualInputPath, "utf-8"));
			expect(stdin).toMatchObject({
				cwd: harness.tempDir,
				event: "PreCompact",
				hook_event_name: "PreCompact",
				reason: "manual",
				session_id: harness.session.sessionId,
				custom_instructions: "original instructions",
			});
			expect(() => readFileSync(autoInputPath, "utf-8")).toThrow();
			expect(() => readFileSync(cancelledPostInputPath, "utf-8")).toThrow();
			const customPayload = JSON.stringify(harness.session.messages.filter((message) => message.role === "custom"));
			expect(customPayload).toContain("manual compaction paused by hook");
			expect(customPayload).toContain("unsupported_field");
			expect(customPayload).toContain("additionalContext");
			expect(customPayload).toContain("customInstructions");
		} finally {
			harness.cleanup();
		}
	});

	it("treats PreCompact additionalContext and customInstructions as diagnostic-only without mutating compaction", async () => {
		// Given
		const hookDir = createTempDir("senpi-hooks-precompact-diagnostic");
		const inputPath = join(hookDir, "input.json");
		const script = createNodeScript(
			hookDir,
			"precompact-diagnostic.mjs",
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(inputPath)}, stdin); process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: 'diagnostic context', customInstructions: 'mutated instructions' } })); });`,
		);
		const harness = await createHarness({
			extensionFactories: [
				{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" },
				{ factory: extensionEchoesCompactionInstructions(), path: "<test:compaction>" },
			],
		});
		writeProjectHooks(harness.tempDir, {
			PreCompact: [{ matcher: "manual", commands: [`${process.execPath} ${script}`] }],
		});
		seedCompactableSession(harness);

		try {
			// When
			const result = await harness.session.compact("original instructions");

			// Then
			expect(result.summary).toBe("instructions:original instructions");
			const stdin: unknown = JSON.parse(readFileSync(inputPath, "utf-8"));
			expect(stdin).toMatchObject({
				cwd: harness.tempDir,
				event: "PreCompact",
				hook_event_name: "PreCompact",
				reason: "manual",
				session_id: harness.session.sessionId,
			});
			const customPayload = JSON.stringify(harness.session.messages.filter((message) => message.role === "custom"));
			expect(customPayload).toContain("PreCompact hook diagnostics.");
			expect(customPayload).toContain("additionalContext");
			expect(customPayload).toContain("customInstructions");
			expect(customPayload).not.toContain("mutated instructions");
		} finally {
			harness.cleanup();
		}
	});

	it("runs PostCompact only after accepted compaction and records sanitized failure diagnostics", async () => {
		// Given
		const hookDir = createTempDir("senpi-hooks-postcompact");
		const postInputPath = join(hookDir, "post-input.json");
		const postScript = createNodeScript(
			hookDir,
			"postcompact.mjs",
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(postInputPath)}, stdin); process.stderr.write('SECRET_TOKEN=postcompact-secret'); process.exit(1); });`,
		);
		const harness = await createHarness({
			extensionFactories: [
				{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" },
				{ factory: extensionProvidedCompaction(), path: "<test:compaction>" },
			],
		});
		writeProjectHooks(harness.tempDir, {
			PostCompact: [{ matcher: "manual", commands: [`${process.execPath} ${postScript}`] }],
		});
		seedCompactableSession(harness);

		try {
			// When
			const result = await harness.session.compact();

			// Then
			expect(result.summary).toBe("summary from extension");
			const stdin: unknown = JSON.parse(readFileSync(postInputPath, "utf-8"));
			expect(stdin).toMatchObject({
				cwd: harness.tempDir,
				event: "PostCompact",
				hook_event_name: "PostCompact",
				reason: "manual",
				session_id: harness.session.sessionId,
			});
			const customText = harness.session.messages
				.filter((message) => message.role === "custom")
				.map((message) => getMessageText(message))
				.join("\n");
			const customPayload = JSON.stringify(harness.session.messages.filter((message) => message.role === "custom"));
			expect(customText).toContain("PostCompact hook diagnostics.");
			expect(customPayload).toContain("Hook command failed with exit code 1.");
			expect(customPayload).not.toContain("postcompact-secret");
			expect(customPayload).not.toContain("SECRET_TOKEN");
		} finally {
			harness.cleanup();
		}
	});

	it("sanitizes PostCompact exit code 2 stderr without exposing it as context", async () => {
		// Given
		const hookDir = createTempDir("senpi-hooks-postcompact-exit-2");
		const postInputPath = join(hookDir, "post-exit-2-input.json");
		const postScript = createNodeScript(
			hookDir,
			"postcompact-exit-2.mjs",
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(postInputPath)}, stdin); process.stderr.write('SECRET_TOKEN=exit-two-secret'); process.exit(2); });`,
		);
		const harness = await createHarness({
			extensionFactories: [
				{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" },
				{ factory: extensionProvidedCompaction(), path: "<test:compaction>" },
			],
		});
		writeProjectHooks(harness.tempDir, {
			PostCompact: [{ matcher: "manual", commands: [`${process.execPath} ${postScript}`] }],
		});
		seedCompactableSession(harness);

		try {
			// When
			const result = await harness.session.compact();

			// Then
			expect(result.summary).toBe("summary from extension");
			const stdin: unknown = JSON.parse(readFileSync(postInputPath, "utf-8"));
			expect(stdin).toMatchObject({
				cwd: harness.tempDir,
				event: "PostCompact",
				hook_event_name: "PostCompact",
				reason: "manual",
				session_id: harness.session.sessionId,
			});
			const customText = harness.session.messages
				.filter((message) => message.role === "custom")
				.map((message) => getMessageText(message))
				.join("\n");
			const customPayload = JSON.stringify(harness.session.messages.filter((message) => message.role === "custom"));
			expect(customText).toContain("PostCompact hook diagnostics.");
			expect(customPayload).not.toContain("exit-two-secret");
			expect(customPayload).not.toContain("SECRET_TOKEN");
		} finally {
			harness.cleanup();
		}
	});
});
