// senpi#5349 / code-yeongyu/oh-my-openagent#12096: the kill guard refuses agent shell text before it runs, for every
// model-facing tool that takes a command. The shell tools here only record what they were asked to run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseHookConfig } from "../../src/core/extensions/builtin/hooks/index.ts";
import { createHookTrustEntry, hookTrustId } from "../../src/core/extensions/builtin/hooks/trust.ts";
import type { HookSourceMetadata, HookTrustEntry } from "../../src/core/extensions/builtin/hooks/types.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { type ExtensionAPI, type ExtensionFactory, ExecuteToolError } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const REPORTER = `pkill -f 'paid" 2>/dev/null || echo 1' ; true`;

function builtin(id: string): ExtensionFactory {
	const entry = builtinExtensions.find((extension) => extension.id === id);
	if (!entry) throw new Error(`missing builtin extension: ${id}`);
	return entry.factory;
}

/** Shell tools that record their input instead of running it. */
function recordingTools(ran: string[]): AgentTool[] {
	const tool = (name: string, field: "command" | "input"): AgentTool => ({
		name,
		label: name,
		description: `records ${name}`,
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params) => {
			const value = (params as Record<string, unknown>)[field];
			ran.push(`${name}: ${String(value)}`);
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	});
	return [tool("bash", "command"), tool("monitor", "command"), tool("bash_input", "input")];
}

type Outcome = { readonly blocked: true; readonly text: string } | { readonly blocked: false };

async function call(harness: Harness, name: string, params: Record<string, unknown>): Promise<Outcome> {
	try {
		await harness.session.executeTool(name, params);
		return { blocked: false };
	} catch (error) {
		if (error instanceof ExecuteToolError && error.code === "blocked") return { blocked: true, text: error.message };
		throw error;
	}
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function setup(
	options: { factories?: ExtensionFactory[]; userSettings?: unknown; projectSettings?: unknown } = {},
) {
	const ran: string[] = [];
	const notices: string[] = [];
	const harness = await createHarness({
		tools: recordingTools(ran),
		extensionFactories: options.factories ?? [builtin("kill-guard")],
	});
	harnesses.push(harness);
	if (options.userSettings !== undefined) {
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.userSettings));
	}
	if (options.projectSettings !== undefined) {
		mkdirSync(join(harness.tempDir, ".senpi"), { recursive: true });
		writeFileSync(join(harness.tempDir, ".senpi", "settings.json"), JSON.stringify(options.projectSettings));
	}
	await harness.session.bindExtensions({
		uiContext: createTestUiContext({ notify: (message: string) => notices.push(message) }),
	});
	return { harness, ran, notices };
}

describe("kill guard on model-facing shell tools", () => {
	it.each([
		["bash", { command: REPORTER }],
		["monitor", { command: REPORTER, description: "watch" }],
		["bash_input", { bash_id: "b1", input: REPORTER }],
		["bash_input", { bash_id: "b1", input: REPORTER, keys: ["enter"], submit: false }],
		["bash_input", { bash_id: "b1", input: "kill -9 -1\n", submit: false }],
		["bash_input", { bash_id: "b1", input: "kill -9 -1\r", submit: false }],
		["bash_input", { bash_id: "b1", input: "echo ok\nkill -9 -1\npartial", submit: false }],
		["bash", { command: "kill -9 -1" }],
	] as const)("refuses %s %j before the tool runs (E1, E2, E3, A7, C18, C19)", async (tool, params) => {
		const { harness, ran } = await setup();

		const outcome = await call(harness, tool, params);

		expect(outcome.blocked).toBe(true);
		if (outcome.blocked) expect(outcome.text).toContain("[senpi:kill-guard]");
		expect(ran).toEqual([]);
	});

	it("does not judge partial bash_input text that is not submitted (A7)", async () => {
		const { harness, ran } = await setup();

		const outcome = await call(harness, "bash_input", { bash_id: "b1", input: REPORTER, submit: false });

		expect(outcome).toEqual({ blocked: false });
		expect(ran).toEqual([`bash_input: ${REPORTER}`]);
	});

	it("lets ordinary and narrow commands through untouched (C1, C11, C15)", async () => {
		const { harness, ran } = await setup();

		for (const command of ["echo kill -9 -1", "pgrep -af node", "kill -0 12345", "docker kill web"]) {
			expect(await call(harness, "bash", { command })).toEqual({ blocked: false });
		}
		expect(ran).toHaveLength(4);
	});

	it("refuses a tool.bash a cell makes through ctx.executeTool (E9)", async () => {
		const results: string[] = [];
		const nested = (pi: ExtensionAPI): void => {
			pi.registerTool({
				name: "run_nested",
				label: "run_nested",
				description: "Runs a nested bash call the way a codemode cell does.",
				parameters: Type.Object({}),
				execute: async (_id, _params, _signal, _onUpdate, ctx) => {
					try {
						const outcome = await ctx.executeTool("bash", { command: REPORTER });
						results.push(JSON.stringify(outcome.result.content));
					} catch (error) {
						results.push(error instanceof Error ? error.message : String(error));
					}
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			});
		};
		const { harness, ran } = await setup({ factories: [builtin("kill-guard"), nested] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("run_nested", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(ran).toEqual([]);
		expect(results).toHaveLength(1);
		expect(results[0]).toContain("[senpi:kill-guard]");
	});

	it("is switched off only by user settings, with one notice a session (C23)", async () => {
		const off = await setup({ userSettings: { terminal: { killGuard: "off" } } });
		expect(await call(off.harness, "bash", { command: REPORTER })).toEqual({ blocked: false });
		expect(off.ran).toEqual([`bash: ${REPORTER}`]);
		expect(off.notices.filter((notice) => notice.includes("kill guard"))).toHaveLength(1);
	});

	it("ignores a project settings value that would switch it off", async () => {
		const { harness, ran } = await setup({ projectSettings: { terminal: { killGuard: "off" } } });

		expect((await call(harness, "bash", { command: REPORTER })).blocked).toBe(true);
		expect(ran).toEqual([]);
	});
});

describe("kill guard runs before PreToolUse hooks and permission prompts (A6, N3)", () => {
	it("refuses under the ask preset with no prompt and no hook run", async () => {
		const ran: string[] = [];
		const prompts: string[] = [];
		const order = ["moved-path-guard", "kill-guard", "hooks", "permission-system"];
		const harness = await createHarness({
			tools: recordingTools(ran),
			extensionFlagValues: new Map([["permission-preset", "ask"]]),
			// The shipped registration order, not a hand-picked one.
			extensionFactories: builtinExtensions
				.filter((entry) => order.includes(entry.id))
				.map((entry) => entry.factory),
		});
		harnesses.push(harness);
		const hookLog = join(harness.tempDir, "pre-tool-use.log");
		const hookScript = join(harness.tempDir, "pre-tool-use.mjs");
		writeFileSync(
			hookScript,
			`import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(hookLog)}, 'ran\\n'); process.stdout.write('{}');`,
		);
		writeTrustedPreToolUseHook(harness.tempDir, `${process.execPath} ${hookScript}`);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title: string) => {
					prompts.push(title);
					return "Deny";
				},
			}),
		});

		const outcome = await call(harness, "bash", { command: REPORTER });

		expect(outcome.blocked).toBe(true);
		if (outcome.blocked) expect(outcome.text).toContain("[senpi:kill-guard]");
		expect(prompts).toEqual([]);
		expect(existsSync(hookLog) ? readFileSync(hookLog, "utf-8") : "").toBe("");
		expect(ran).toEqual([]);
	});
});

function writeTrustedPreToolUseHook(cwd: string, command: string): void {
	const senpiDir = join(cwd, ".senpi");
	mkdirSync(senpiDir, { recursive: true });
	const sourcePath = join(senpiDir, "hooks.json");
	const hookConfig = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } };
	writeFileSync(sourcePath, JSON.stringify(hookConfig));
	const source = {
		discoveredAt: "pre-session",
		displayOrder: 0,
		scope: "project",
		sourcePath,
	} satisfies HookSourceMetadata;
	const hooks: Record<string, HookTrustEntry> = {};
	for (const handler of parseHookConfig(hookConfig, source).executableHandlers) {
		hooks[hookTrustId(handler)] = createHookTrustEntry(handler, {
			platform: process.platform,
			updatedAt: "2026-11-01T00:00:00.000Z",
		});
	}
	writeFileSync(join(senpiDir, "hooks-state.json"), JSON.stringify({ version: 1, hooks }));
}
