import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import { emitAskUserNotification } from "../../src/core/extensions/builtin/ask-user/notify.ts";
import { parseHookConfig, SUPPORTED_HOOK_EVENTS } from "../../src/core/extensions/builtin/hooks/index.ts";
import { matchingHookHandlers } from "../../src/core/extensions/builtin/hooks/matcher.ts";
import { parseHookOutput } from "../../src/core/extensions/builtin/hooks/output-parser.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionContext, QuestionResponse } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const SOURCE: HookSourceMetadata = {
	discoveredAt: "pre-session",
	displayOrder: 7,
	scope: "project",
	sourcePath: "/repo/.senpi/hooks.json",
};

describe("builtin hooks Notification event", () => {
	it("is a supported event that parses handlers without diagnostics", () => {
		const parsed = parseHookConfig(
			{
				hooks: {
					Notification: [{ matcher: "ask-user-timeout", hooks: [{ type: "command", command: "notify.sh" }] }],
				},
			},
			SOURCE,
		);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.executableHandlers).toHaveLength(1);
		expect(parsed.executableHandlers[0]).toMatchObject({ event: "Notification", matcher: "ask-user-timeout" });
		expect(SUPPORTED_HOOK_EVENTS).toContain("Notification");
	});

	it("delivers Notification input to every handler regardless of matcher", () => {
		const parsed = parseHookConfig(
			{
				hooks: {
					Notification: [{ matcher: "something-else", hooks: [{ type: "command", command: "notify.sh" }] }],
				},
			},
			SOURCE,
		);
		const matched = matchingHookHandlers(
			{
				cwd: "/repo",
				event: "Notification",
				hook_event_name: "Notification",
				kind: "ask-user-timeout",
				message: "Question timed out",
				session_id: "session-1",
			},
			parsed.executableHandlers,
		);
		expect(matched.handlers).toHaveLength(1);
	});

	it("fires Notification with the timed-out question payload through the ask-user tool", async () => {
		const hookDir = join(tmpdir(), `senpi-notification-hook-${Date.now()}`);
		mkdirSync(hookDir, { recursive: true });
		const stdinPath = join(hookDir, "stdin.json");
		const scriptPath = join(hookDir, "notify.mjs");
		writeFileSync(
			scriptPath,
			`import { writeFileSync } from 'node:fs'; let stdin = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { stdin += chunk; }); process.stdin.on('end', () => { writeFileSync(${JSON.stringify(stdinPath)}, stdin); process.stdout.write(JSON.stringify({})); });`,
			"utf-8",
		);
		const hooksExtension = builtinExtensions.find((entry) => entry.id === "hooks");
		if (hooksExtension === undefined) throw new Error("builtin hooks extension is not registered");
		const harness: Harness = await createHarness({
			extensionFactories: [
				{ factory: hooksExtension.factory, path: "<builtin:hooks>" },
				{ factory: askUserExtension, path: "<builtin:ask-user>" },
			],
			settings: { askUser: { enabled: true } },
		});
		try {
			await harness.session.bindExtensions({});
			const senpiDir = join(harness.tempDir, ".senpi");
			mkdirSync(senpiDir, { recursive: true });
			const hookConfig = {
				hooks: { Notification: [{ hooks: [{ type: "command", command: `${process.execPath} ${scriptPath}` }] }] },
			};
			writeFileSync(join(senpiDir, "hooks.json"), `${JSON.stringify(hookConfig, null, 2)}\n`, "utf-8");
			const source = {
				discoveredAt: "pre-session",
				displayOrder: 0,
				scope: "project",
				sourcePath: join(senpiDir, "hooks.json"),
			} satisfies HookSourceMetadata;
			const parsed = parseHookConfig(hookConfig, source);
			const hooks: Record<string, HookTrustEntry> = {};
			for (const handler of parsed.executableHandlers) {
				hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
					platform: process.platform,
					updatedAt: "2026-06-29T00:00:00.000Z",
				});
			}
			writeFileSync(
				join(senpiDir, "hooks-state.json"),
				`${JSON.stringify({ version: 1, hooks }, null, 2)}\n`,
				"utf-8",
			);
			const runner = harness.getExtensionRunner();
			const timedOut: QuestionResponse = {
				answers: {},
				autoResolvedAfterMs: 1_800_000,
				status: "timed_out",
				unanswered: ["q1"],
			};
			const ctx: ExtensionContext = {
				...runner.createContext(),
				hasUI: true,
				mode: "tui",
				ui: { ...runner.createContext().ui, question: vi.fn(async () => timedOut) },
			};
			const sent: unknown[] = [];
			const timedOutResponse: QuestionResponse = timedOut;
			await emitAskUserNotification(
				{ sendMessage: (message: unknown) => void sent.push(message) },
				ctx,
				{
					questions: [
						{ id: "q1", header: "Library", question: "Which library?", options: [], multiSelect: false },
					],
					requestId: "notification-timeout",
					timeoutMs: 1_800_000,
					waitForAnswer: true,
				},
				timedOutResponse,
				"claude",
			);
			const stdin: unknown = JSON.parse(readFileSync(stdinPath, "utf-8"));
			expect(stdin).toMatchObject({
				event: "Notification",
				hook_event_name: "Notification",
				kind: "ask-user-timeout",
				request_id: "notification-timeout",
				status: "timed_out",
			});
		} finally {
			harness.cleanup();
			rmSync(hookDir, { recursive: true, force: true });
		}
	});

	it("accepts additionalContext and rejects decisions for Notification output", () => {
		const accepted = parseHookOutput({
			event: "Notification",
			exitCode: 0,
			source: SOURCE,
			stderr: "",
			stdout: JSON.stringify({ additionalContext: "hook saw the timeout" }),
		});
		expect(accepted.diagnostics).toEqual([]);
		expect(accepted.output.additionalContext).toBe("hook saw the timeout");
		const rejected = parseHookOutput({
			event: "Notification",
			exitCode: 0,
			source: SOURCE,
			stderr: "",
			stdout: JSON.stringify({ decision: "block" }),
		});
		expect(rejected.output.decision).toBeUndefined();
		expect(rejected.diagnostics).toContainEqual(
			expect.objectContaining({ code: "unsupported_field", event: "Notification" }),
		);
	});
});
