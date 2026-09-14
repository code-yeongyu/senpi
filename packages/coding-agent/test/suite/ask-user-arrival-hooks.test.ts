// Refs #1645: a real Notification command receives each fresh question in either wait mode.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import hooksExtension, { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import type { ExtensionContext, QuestionResponse } from "../../src/core/extensions/types.ts";
import { createHarness } from "./harness.ts";

describe("ask-user arrival hooks", () => {
	it.each([true, false])("dispatches one ask-user-asked Notification for wait=%s", async (waitForAnswer) => {
		const dir = mkdtempSync(join(tmpdir(), "ask-user-arrival-hook-"));
		const received = join(dir, "received.jsonl");
		const script = join(dir, "notify.mjs");
		writeFileSync(
			script,
			`import { appendFileSync } from 'node:fs'; let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c=>text+=c); process.stdin.on('end',()=>{const input=JSON.parse(text);if(input.kind==='ask-user-asked'){appendFileSync(${JSON.stringify(received)},JSON.stringify(input)+'\\n');process.stdout.write(JSON.stringify({additionalContext:'ARRIVAL-HOOK-OBSERVED'}));}else process.stdout.write('{}');});`,
		);
		const harness = await createHarness({
			extensionFactories: [
				{ factory: hooksExtension, path: "<builtin:hooks>" },
				{ factory: askUserExtension, path: "<builtin:ask-user>" },
			],
			settings: { askUser: { enabled: true } },
		});
		const response = Promise.withResolvers<QuestionResponse>();
		let execution: Promise<unknown> | undefined;
		try {
			await harness.session.bindExtensions({});
			const project = join(harness.tempDir, ".senpi");
			mkdirSync(project, { recursive: true });
			const config = {
				hooks: {
					Notification: [
						{
							hooks: [
								{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` },
							],
						},
					],
				},
			};
			const source = {
				discoveredAt: "pre-session",
				displayOrder: 0,
				scope: "project",
				sourcePath: join(project, "hooks.json"),
			} satisfies HookSourceMetadata;
			writeFileSync(source.sourcePath, JSON.stringify(config));
			const trust: Record<string, HookTrustEntry> = {};
			for (const handler of parseHookConfig(config, source).executableHandlers)
				trust[hookTrustId(handler)] = createHookTrustEntry(handler, {
					platform: process.platform,
					updatedAt: "2026-09-13T00:00:00.000Z",
				});
			writeFileSync(join(project, "hooks-state.json"), JSON.stringify({ version: 1, hooks: trust }));
			const runner = harness.getExtensionRunner();
			const base = runner.createContext();
			const ctx: ExtensionContext = {
				...base,
				mode: "tui",
				hasUI: true,
				ui: { ...base.ui, question: () => response.promise },
			};
			const completed = Promise.withResolvers<void>();
			const unsubscribe = harness.session.subscribe((event) => {
				if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.content === "ARRIVAL-HOOK-OBSERVED"
				)
					completed.resolve();
			});
			const timeout = setTimeout(() => completed.reject(new Error("Arrival Notification did not complete")), 5_000);
			try {
				const tool = runner
					.getAllRegisteredTools()
					.find((entry) => entry.definition.name === "ask_user_question")?.definition;
				if (!tool) throw new Error("Missing question tool");
				execution = tool.execute(
					"hook-arrival",
					{ questions: [{ header: "Auth", question: "Which flow?", multiSelect: false }], waitForAnswer },
					undefined,
					undefined,
					ctx,
				);
				await completed.promise;
				const rows = readFileSync(received, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, unknown>);
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					kind: "ask-user-asked",
					request_id: "hook-arrival",
					event: "Notification",
					title: "Auth",
				});
			} finally {
				clearTimeout(timeout);
				unsubscribe();
			}
		} finally {
			response.resolve({ status: "cancelled", answers: {}, unanswered: ["q1"] });
			await execution;
			await Promise.resolve();
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
