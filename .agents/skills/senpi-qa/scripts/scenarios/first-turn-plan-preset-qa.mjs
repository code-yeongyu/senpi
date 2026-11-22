#!/usr/bin/env node
// senpi-qa scenario for senpi#7101 and senpi#7100: what the first request of a session carries under each prompt
// preset. The real CLI runs in `--mode rpc` (print and json modes never arm the first-turn plan
// opener) against the fake model server, and the captured request body is the proof:
//
// - a GPT preset with `todo.firstTurnPlan` unset: no forced `todo` tool_choice, no hidden reminder;
// - `todo.firstTurnPlan: "force"` set by the user under a GPT preset: both are back;
// - a Claude preset: both, as before;
// - the gpt-6.2 core: its own goal and todo rules, no Task_Management block, and the opener on
//   the terminal surface (the "I read this as" line) and on the app surface (plain sentences);
// - the deepseek-v4-1-flash core, over chat completions: the same four facts as gpt-6.2, while the
//   deepseek-v4-flash-0731 preset keeps the forced todo, the reminder and Task_Management.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/first-turn-plan-preset-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/scenarios/first-turn-plan-preset-qa.mjs --self-test --evidence first-turn-plan-preset
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { API_PRESETS, checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";

const REMINDER_SENTINEL = "This is the first request of the session";
const TASK_MANAGEMENT_TAG = "<Task_Management>";
const TERMINAL_OPENER = "I read this as [what you take the user to want]";
const APP_OPENER = "what you take them to want and what it is for";
const PLAN_SECTION = "## Goal and plan";
const PROMPT = "add retries to fetchUser";
const TITLE_REQUEST = "Generate a concise title";
const WAIT_TIMEOUT_MS = 90000;

const SCENARIOS = [
	{
		name: "gpt-6.2-astra-ultrafast-default",
		api: "openai-responses",
		model: "gpt-6.2-astra-ultrafast",
		expect: { forcedTodo: false, reminder: false, taskManagement: false, planSection: true, terminalOpener: true },
	},
	{
		name: "gpt-6.2-sol-app-surface",
		api: "openai-responses",
		model: "gpt-6.2-sol",
		surface: "app",
		expect: { forcedTodo: false, reminder: false, taskManagement: false, planSection: true, appOpener: true },
	},
	{
		name: "gpt-6.2-astra-user-force",
		api: "openai-responses",
		model: "gpt-6.2-astra",
		firstTurnPlan: "force",
		expect: { forcedTodo: true, reminder: true, taskManagement: false, planSection: true, terminalOpener: true },
	},
	{
		name: "gpt-6-astra-default",
		api: "openai-responses",
		model: "gpt-6-astra",
		expect: { forcedTodo: false, reminder: false, taskManagement: true, planSection: false },
	},
	{
		name: "claude-opus-5-default",
		api: "anthropic-messages",
		model: "claude-opus-5",
		expect: { forcedTodo: true, reminder: true, taskManagement: true, planSection: false },
	},
	{
		name: "deepseek-v4.1-flash-ultrafast-default",
		api: "openai-completions",
		model: "deepseek-v4.1-flash-ultrafast",
		expect: { forcedTodo: false, reminder: false, taskManagement: false, planSection: true, terminalOpener: true },
	},
	{
		name: "deepseek-flash-app-surface",
		api: "openai-completions",
		model: "deepseek-flash",
		surface: "app",
		expect: { forcedTodo: false, reminder: false, taskManagement: false, planSection: true, appOpener: true },
	},
	{
		name: "deepseek-flash-user-force",
		api: "openai-completions",
		model: "deepseek-flash",
		firstTurnPlan: "force",
		expect: { forcedTodo: true, reminder: true, taskManagement: false, planSection: true, terminalOpener: true },
	},
	{
		name: "deepseek-v4-flash-0731-default",
		api: "openai-completions",
		model: "deepseek-v4-flash-0731",
		expect: { forcedTodo: true, reminder: true, taskManagement: true, planSection: false },
	},
];

const argv = process.argv.slice(2);
const evidenceSlug = argv.includes("--evidence") ? argv[argv.indexOf("--evidence") + 1] : undefined;

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/** The system prompt as the wire carries it: `instructions` or developer/system items (Responses), `system` (Anthropic), system/developer messages (Chat Completions). */
function systemTextOf(body) {
	const parts = [];
	if (typeof body?.instructions === "string") parts.push(body.instructions);
	if (body?.system !== undefined) parts.push(textOf(body.system));
	const items = [body?.input, body?.messages].flatMap((list) => (Array.isArray(list) ? list : []));
	for (const item of items) {
		if (item?.role === "developer" || item?.role === "system") parts.push(textOf(item.content));
	}
	return parts.join("\n");
}

function forcesTodo(toolChoice) {
	return toolChoice?.name === "todo" || toolChoice?.function?.name === "todo";
}

async function runScenario(scenario, checks, evidence) {
	const preset = API_PRESETS[scenario.api];
	const box = makeSandbox(`first-turn-${scenario.name}`);
	const server = await startFakeModelServer({ turns: [{ text: "FIRST-TURN-QA-DONE" }] });
	writeMockModelsJson(box.agentDir, server, scenario.api, { id: scenario.model, name: scenario.model });
	if (scenario.firstTurnPlan !== undefined) {
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify({ todo: { firstTurnPlan: scenario.firstTurnPlan } }, null, 2),
		);
	}
	const env = hermeticEnv(box.env);
	if (scenario.surface === undefined) delete env.SENPI_PROMPT_SURFACE;
	else env.SENPI_PROMPT_SURFACE = scenario.surface;
	const client = new RpcClient({
		env,
		cwd: box.cwd,
		extraArgs: ["--provider", preset.provider, "--model", scenario.model, "--no-extensions", "--approve"],
	});
	try {
		await client.send({ type: "get_state" });
		// Subscribed before the prompt goes out, so the turn's end cannot be missed.
		const turnEnded = client.waitForEvent((event) => event.type === "agent_end", { timeoutMs: WAIT_TIMEOUT_MS });
		const ack = await client.send({ type: "prompt", message: PROMPT });
		checks.ok(`${scenario.name}: RPC accepted the prompt`, ack.success === true);
		await turnEnded;
		// The session's own first request: the one that carries the prompt, not the title side request.
		const first = server.requests.find(
			(request) => request.method === "POST" && request.raw.includes(PROMPT) && !request.raw.includes(TITLE_REQUEST),
		);
		checks.ok(`${scenario.name}: the first provider request was captured`, first !== undefined);
		const body = first?.body ?? {};
		const raw = JSON.stringify(body);
		const system = systemTextOf(body);
		const { expect } = scenario;

		checks.ok(`${scenario.name}: wire model is ${scenario.model}`, body.model === scenario.model, String(body.model));
		checks.ok(
			`${scenario.name}: todo tool_choice ${expect.forcedTodo ? "forced" : "not forced"}`,
			forcesTodo(body.tool_choice) === expect.forcedTodo,
			`tool_choice=${JSON.stringify(body.tool_choice ?? null)}`,
		);
		checks.ok(
			`${scenario.name}: first-turn reminder ${expect.reminder ? "present" : "absent"}`,
			raw.includes(REMINDER_SENTINEL) === expect.reminder,
		);
		checks.ok(`${scenario.name}: request carries a system prompt`, system.length > 0, `${system.length} chars`);
		checks.ok(
			`${scenario.name}: Task_Management ${expect.taskManagement ? "appended" : "not appended"}`,
			system.includes(TASK_MANAGEMENT_TAG) === expect.taskManagement,
		);
		checks.ok(
			`${scenario.name}: "Goal and plan" section ${expect.planSection ? "rendered" : "absent"}`,
			system.includes(PLAN_SECTION) === expect.planSection,
		);
		if (expect.terminalOpener) {
			checks.ok(`${scenario.name}: terminal opener line rendered`, system.includes(TERMINAL_OPENER));
		}
		if (expect.appOpener) {
			checks.ok(
				`${scenario.name}: app opener rendered without the terminal template`,
				system.includes(APP_OPENER) && !system.includes("I read this as"),
			);
		}
		if (evidence !== undefined) {
			writeFileSync(join(evidence, `${scenario.name}.system-prompt.txt`), system);
			writeFileSync(
				join(evidence, `${scenario.name}.request.json`),
				JSON.stringify({ model: body.model, tool_choice: body.tool_choice ?? null, body }, null, 2),
			);
		}
	} finally {
		client.close();
		await server.stop();
		box.cleanup();
	}
}

async function selfTest() {
	installCleanupHooks();
	const checks = createChecks("first-turn-plan-preset-qa.mjs --self-test");
	const guard = guardRealAuth();
	const evidence = evidenceSlug === undefined ? undefined : evidenceDir(evidenceSlug);
	for (const scenario of SCENARIOS) {
		await checks.run(`${scenario.name}: scenario completed`, () => runScenario(scenario, checks, evidence));
	}
	checkRealAuthUnchanged(checks, guard);
	if (evidence !== undefined) process.stderr.write(`evidence: ${evidence}\n`);
	process.exit(checks.finish() ? 0 : 1);
}

if (argv[0] === "--self-test") {
	selfTest().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	});
} else {
	process.stderr.write(
		[
			"senpi-qa - first request of a session under each prompt preset (RPC channel, senpi#7101, senpi#7100)",
			"  node first-turn-plan-preset-qa.mjs --self-test [--evidence <slug>]",
			"",
		].join("\n"),
	);
	process.exitCode = 2;
}
