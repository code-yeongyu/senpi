import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import {
	STOP_DIAGNOSTICS_CUSTOM_TYPE,
	STOP_STATE_CUSTOM_TYPE,
} from "../../src/core/extensions/builtin/hooks/stop-adapter.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { CustomEntry, SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, getUserTexts } from "./harness.ts";

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

function writeStopHookProject(cwd: string, command: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const sourcePath = join(senpiDir, "hooks.json");
	const hookConfig = {
		hooks: {
			Stop: [
				{
					hooks: [{ type: "command", command }],
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

function createNodeScript(dir: string, name: string, body: string): string {
	const scriptPath = join(dir, name);
	writeFileSync(scriptPath, body, "utf-8");
	return scriptPath;
}

function isCustomEntryOfType(entry: SessionEntry, customType: string): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === customType;
}

function readStopStates(harness: Awaited<ReturnType<typeof createHarness>>): unknown[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => isCustomEntryOfType(entry, STOP_STATE_CUSTOM_TYPE))
		.map((entry) => entry.data);
}

function readStopDiagnostics(harness: Awaited<ReturnType<typeof createHarness>>): unknown[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => isCustomEntryOfType(entry, STOP_DIAGNOSTICS_CUSTOM_TYPE))
		.map((entry) => entry.data);
}

function readStopOutputs(harness: Awaited<ReturnType<typeof createHarness>>): unknown[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => isCustomEntryOfType(entry, "senpi.hooks.stop-output"))
		.map((entry) => entry.data);
}

afterEach(() => {
	for (const dir of createdDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("builtin hooks Stop adapter", () => {
	it("queues a follow-up and records session stop state when a Stop hook blocks with context", async () => {
		// Given
		const hookDir = createTempDir("senpi-stop-followup-hook");
		const counterPath = join(hookDir, "counter.txt");
		const stdinPath = join(hookDir, "stdin.json");
		const scriptPath = createNodeScript(
			hookDir,
			"stop-context.mjs",
			`import { existsSync, readFileSync, writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(stdinPath)}, stdin); const previous = existsSync(${JSON.stringify(counterPath)}) ? Number(readFileSync(${JSON.stringify(counterPath)}, 'utf-8')) : 0; const next = previous + 1; writeFileSync(${JSON.stringify(counterPath)}, String(next)); if (next === 1) process.stdout.write(JSON.stringify({ decision: 'block', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Please inspect the final answer.' } })); });`,
		);
		const harness = await createHarness({
			extensionFactories: [{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" }],
		});
		writeStopHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([fauxAssistantMessage("draft"), fauxAssistantMessage("revised")]);

		try {
			// When
			await harness.session.prompt("ship it");

			// Then
			expect(getUserTexts(harness)).toEqual(["ship it", "Please inspect the final answer."]);
			expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual(
				["draft", "revised"],
			);
			const stdin: unknown = JSON.parse(readFileSync(stdinPath, "utf-8"));
			expect(stdin).toMatchObject({
				cwd: harness.tempDir,
				event: "Stop",
				hook_event_name: "Stop",
				session_id: harness.session.sessionId,
			});
			expect(readStopStates(harness)).toContainEqual(
				expect.objectContaining({
					count: 1,
					sessionId: harness.session.sessionId,
				}),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("records nonblocking Stop output without queuing a follow-up", async () => {
		// Given
		const hookDir = createTempDir("senpi-stop-nonblocking-hook");
		const scriptPath = createNodeScript(
			hookDir,
			"stop-nonblocking.mjs",
			"process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ reason: 'SECRET_REASON', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'SECRET_CONTEXT' } })); });",
		);
		const harness = await createHarness({
			extensionFactories: [{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" }],
		});
		writeStopHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([fauxAssistantMessage("done")]);

		try {
			// When
			await harness.session.prompt("finish normally");

			// Then
			expect(getUserTexts(harness)).toEqual(["finish normally"]);
			expect(harness.getPendingResponseCount()).toBe(0);
			const outputPayload = JSON.stringify(readStopOutputs(harness));
			expect(outputPayload).toContain("stdout.reason");
			expect(outputPayload).toContain("stdout.hookSpecificOutput.additionalContext");
			expect(outputPayload).not.toContain("SECRET_REASON");
			expect(outputPayload).not.toContain("SECRET_CONTEXT");
		} finally {
			harness.cleanup();
		}
	});

	it("records unsupported Stop output fields as diagnostics without triggering a follow-up", async () => {
		// Given
		const hookDir = createTempDir("senpi-stop-unsupported-hook");
		const scriptPath = createNodeScript(
			hookDir,
			"stop-unsupported.mjs",
			"process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ decision: 'approve', systemMessage: 'SECRET_SYSTEM_MESSAGE', suppressOutput: true, stopReason: 'SECRET_STOP_REASON', updatedInput: 'SECRET_INPUT', updatedToolOutput: 'SECRET_TOOL_OUTPUT' })); });",
		);
		const harness = await createHarness({
			extensionFactories: [{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" }],
		});
		writeStopHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([fauxAssistantMessage("done")]);

		try {
			// When
			await harness.session.prompt("finish once");

			// Then
			expect(getUserTexts(harness)).toEqual(["finish once"]);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(readStopStates(harness)).toContainEqual(
				expect.objectContaining({
					count: 0,
					sessionId: harness.session.sessionId,
				}),
			);
			const customPayload = JSON.stringify(readStopDiagnostics(harness));
			expect(customPayload).toContain("unsupported_field");
			expect(customPayload).toContain("stdout.systemMessage");
			expect(customPayload).toContain("stdout.suppressOutput");
			expect(customPayload).toContain("stdout.stopReason");
			expect(customPayload).toContain("stdout.updatedInput");
			expect(customPayload).toContain("stdout.updatedToolOutput");
			expect(customPayload).not.toContain("SECRET_SYSTEM_MESSAGE");
			expect(customPayload).not.toContain("SECRET_STOP_REASON");
			expect(customPayload).not.toContain("SECRET_INPUT");
			expect(customPayload).not.toContain("SECRET_TOOL_OUTPUT");
		} finally {
			harness.cleanup();
		}
	});

	it("sanitizes mismatched hookSpecificOutput hookEventName diagnostics", async () => {
		// Given
		const hookDir = createTempDir("senpi-stop-mismatched-hook-event");
		const scriptPath = createNodeScript(
			hookDir,
			"stop-mismatched-event.mjs",
			"process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'TOP_SECRET_STOP_VALUE', additionalContext: 'SECRET_CONTEXT' } })); });",
		);
		const harness = await createHarness({
			extensionFactories: [{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" }],
		});
		writeStopHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([fauxAssistantMessage("done")]);

		try {
			// When
			await harness.session.prompt("finish with mismatched stop output");

			// Then
			expect(getUserTexts(harness)).toEqual(["finish with mismatched stop output"]);
			expect(harness.getPendingResponseCount()).toBe(0);
			const diagnosticsPayload = JSON.stringify(readStopDiagnostics(harness));
			expect(diagnosticsPayload).toContain("invalid_event_config");
			expect(diagnosticsPayload).toContain("stdout.hookSpecificOutput.hookEventName");
			expect(diagnosticsPayload).toContain("does not match Stop");
			expect(diagnosticsPayload).not.toContain("TOP_SECRET_STOP_VALUE");
			expect(diagnosticsPayload).not.toContain("SECRET_CONTEXT");
			expect(JSON.stringify(readStopOutputs(harness))).not.toContain("TOP_SECRET_STOP_VALUE");
			expect(JSON.stringify(readStopOutputs(harness))).not.toContain("SECRET_CONTEXT");
			expect(getUserTexts(harness).join("\n")).not.toContain("TOP_SECRET_STOP_VALUE");
			expect(getUserTexts(harness).join("\n")).not.toContain("SECRET_CONTEXT");
			expect(harness.session.messages.map(getMessageText).join("\n")).not.toContain("TOP_SECRET_STOP_VALUE");
			expect(harness.session.messages.map(getMessageText).join("\n")).not.toContain("SECRET_CONTEXT");
		} finally {
			harness.cleanup();
		}
	});

	it("caps repeated Stop hook reentry at eight blocks and resets for a new user turn", async () => {
		// Given
		const hookDir = createTempDir("senpi-stop-cap-hook");
		const counterPath = join(hookDir, "counter.txt");
		const scriptPath = createNodeScript(
			hookDir,
			"stop-loop.mjs",
			`import { existsSync, readFileSync, writeFileSync } from 'node:fs'; process.stdin.resume(); process.stdin.on('end', () => { const previous = existsSync(${JSON.stringify(counterPath)}) ? Number(readFileSync(${JSON.stringify(counterPath)}, 'utf-8')) : 0; const next = previous + 1; writeFileSync(${JSON.stringify(counterPath)}, String(next)); if (next <= 10) { process.stdout.write(JSON.stringify({ decision: 'block', reason: 'loop follow-up' })); } });`,
		);
		const harness = await createHarness({
			extensionFactories: [{ factory: hooksExtensionFactory(), path: "<builtin:hooks>" }],
		});
		writeStopHookProject(harness.tempDir, `${process.execPath} ${scriptPath}`);
		harness.setResponses([
			fauxAssistantMessage("first-0"),
			fauxAssistantMessage("first-1"),
			fauxAssistantMessage("first-2"),
			fauxAssistantMessage("first-3"),
			fauxAssistantMessage("first-4"),
			fauxAssistantMessage("first-5"),
			fauxAssistantMessage("first-6"),
			fauxAssistantMessage("first-7"),
			fauxAssistantMessage("first-8"),
			fauxAssistantMessage("second-0"),
			fauxAssistantMessage("second-1"),
		]);

		try {
			// When
			await harness.session.prompt("first user turn");
			await harness.session.agent.waitForIdle();
			await harness.session.prompt("second user turn");

			// Then
			expect(readFileSync(counterPath, "utf-8")).toBe("11");
			const userTexts = getUserTexts(harness);
			expect(userTexts.filter((text) => text === "loop follow-up")).toHaveLength(9);
			expect(userTexts).toContain("second user turn");
			const stopStates = readStopStates(harness);
			expect(stopStates).toContainEqual(expect.objectContaining({ count: 8, sessionId: harness.session.sessionId }));
			expect(stopStates.at(-1)).toEqual(expect.objectContaining({ count: 1 }));
			const customPayload = JSON.stringify(readStopDiagnostics(harness));
			expect(customPayload).toContain("Stop hook reentry limit reached.");
		} finally {
			harness.cleanup();
		}
	});
});
