import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { FakeEvalHandleHost } from "./fakes/eval-handle-host.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

interface FauxContext {
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
}

function extractToolResultText(context: FauxContext): string {
	const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
	return toolResult ? getMessageText(toolResult) : "missing tool result";
}

/**
 * The task owner as an extension: it answers the `task` tool from the fake host and provides the host
 * capability for the session. `settle` scripts what happens to each spawned child.
 */
function taskOwnerExtension(host: FakeEvalHandleHost, settle: (ids: readonly string[]) => void): ExtensionFactory {
	return (pi) => {
		const spawned: string[] = [];
		pi.registerTool({
			name: "task",
			label: "Task",
			description: "Spawns a scripted child in the fake handle host.",
			parameters: Type.Object({ prompt: Type.String() }, { additionalProperties: true }),
			execute: async (_toolCallId, params) => {
				const result = await host.executeTool("task", params);
				const details = result.details;
				if (
					typeof details === "object" &&
					details !== null &&
					"task_id" in details &&
					typeof details.task_id === "string"
				) {
					spawned.push(details.task_id);
					settle(spawned);
				}
				return result;
			},
		});
		pi.on("session_start", (_event, ctx) => {
			// Children spawned from now on belong to this session, exactly as a real task owner would record them.
			host.ownerSessionId = ctx.sessionManager.getSessionId();
			pi.provideEvalHandleHost(host);
		});
	};
}

async function createQaHarness(extensionFactory: ExtensionFactory): Promise<Harness> {
	const tempDir = mkdtempSync(join(tmpdir(), "senpi-codemode-wait-qa-"));
	const loader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: join(tempDir, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		extensionFactories: [extensionFactory],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	await harness.session.bindExtensions({});
	return {
		...harness,
		cleanup() {
			harness.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function runEvalTurn(harness: Harness, code: string): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("eval", { language: "js", code, summary: "wait on agent handles" }), {
			stopReason: "toolUse",
		}),
		(context: FauxContext) => fauxAssistantMessage(extractToolResultText(context)),
	]);
	await harness.session.prompt("run eval");
	return getAssistantTexts(harness).join("\n");
}

describe("codemode wait() QA over the fake EvalHandleHost", () => {
	it("happy: two agent handles waited in input order even though the second child finishes first", async () => {
		const host = new FakeEvalHandleHost({ ownerSessionId: "qa" });
		// The children settle only after wait() has subscribed, B first and then A, so the barrier is
		// really parked and input order is what the result proves.
		const spawned: string[] = [];
		host.watchSetupHook = () => {
			const [a, b] = spawned;
			if (a === undefined || b === undefined) return;
			setTimeout(() => {
				host.settle(b, "valueB");
				host.settle(a, "valueA");
			}, 0);
		};
		const harness = await createQaHarness(
			taskOwnerExtension(host, (ids) => {
				spawned.splice(0, spawned.length, ...ids);
			}),
		);
		try {
			const output = await runEvalTurn(
				harness,
				`const a = await agent("first", { handle: true });
const b = await agent("second", { handle: true });
return await wait([a, b], { timeout: 600 });`,
			);
			expect(output).toContain('"valueA"');
			expect(output.indexOf('"valueA"')).toBeLessThan(output.indexOf('"valueB"'));
			expect(host.toolCallCount("task")).toBe(2);
			expect(host.toolCallCount("task_output")).toBe(0);
			expect(host.openWatches).toBe(0);
			const sessionId = harness.session.sessionManager.getSessionId();
			expect(host.calls.every((call) => call.ownerSessionId === sessionId)).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("failure: wait([a], {timeout: 1}) on a slow child times out with the documented text and cancels nothing", async () => {
		const host = new FakeEvalHandleHost({ ownerSessionId: "qa" });
		const harness = await createQaHarness(taskOwnerExtension(host, () => {}));
		try {
			const output = await runEvalTurn(
				harness,
				`const a = await agent("slow", { handle: true });
return await wait([a], { timeout: 1 });`,
			);
			expect(output).toContain(
				"eval_wait_timeout: wait() timed out after 1s; 0/1 handles settled; work was not cancelled",
			);
			const [spawned] = host.toolCalls.filter((call) => call.name === "task");
			expect(spawned).toBeDefined();
			const ref = host.calls.find((call) => call.op === "watch")?.refs[0];
			if (ref === undefined) throw new Error("the wait never subscribed");
			expect(host.epochState(ref.id, ref.run_epoch)).toMatchObject({ phase: "pending", cancelCalls: [] });
			expect(host.openWatches).toBe(0);
			expect(host.toolCallCount("task_output")).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
