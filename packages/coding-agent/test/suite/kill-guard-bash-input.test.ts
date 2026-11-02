// senpi#5349 / code-yeongyu/oh-my-openagent#12096: bash_input lines are judged as the shell's line editor builds them,
// across calls, reloads and the life of each background session. The tools only record what they were asked to run.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { type ExtensionAPI, ExecuteToolError } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const killGuard = builtinExtensions.find((extension) => extension.id === "kill-guard")?.factory;

function recordingBashInput(ran: string[]): AgentTool {
	return {
		name: "bash_input",
		label: "bash_input",
		description: "records bash_input",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, params) => {
			ran.push(JSON.stringify(params));
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	};
}

type Outcome = { readonly blocked: true; readonly text: string } | { readonly blocked: false };

async function call(harness: Harness, params: Record<string, unknown>): Promise<Outcome> {
	try {
		await harness.session.executeTool("bash_input", params);
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

async function setup() {
	if (killGuard === undefined) throw new Error("missing builtin extension: kill-guard");
	const ran: string[] = [];
	const bus: { pi?: ExtensionAPI } = {};
	const harness = await createHarness({
		tools: [recordingBashInput(ran)],
		extensionFactories: [
			killGuard,
			(pi: ExtensionAPI) => {
				bus.pi = pi;
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	// What the terminal extension publishes whenever its set of running background sessions changes.
	const running = (ids: readonly string[]) =>
		bus.pi?.events.emit(WAKE_SOURCE_STATE_EVENT, {
			source: "terminal-background-sessions",
			activeCount: ids.length,
			items: ids.map((id) => ({ id })),
		});
	return { harness, ran, running };
}

describe("kill guard on bash_input line editing", () => {
	it.each([
		["ctrl+a, then type at the start", [{ input: "ill -9 -1\x01k\n", submit: false }]],
		["Home, then type at the start", [{ input: "ill -9 -1\x1b[Hk" }]],
		[
			"ctrl+u, then yank it back with ctrl+y",
			[{ input: "kill -9 -1", submit: false }, { keys: ["ctrl+u"] }, { keys: ["\x19", "enter"] }],
		],
		[
			"a yank on the next line",
			[{ input: "kill -9 -1", submit: false }, { keys: ["ctrl+u", "enter"] }, { keys: ["\x19", "enter"] }],
		],
		["tab completion of a kill-family prefix", [{ input: "kil\t -9 -1\n", submit: false }]],
		["an unknown cursor key between the pieces", [{ input: "ll -9 -1\x1b[1;5Dki" }]],
		["an escape the shell reads shorter than the guard", [{ input: "\x1b[ kill -9 -1\n", submit: false }]],
		["ctrl+v quoting an escape", [{ input: "\x16\x1b[ ; kill -9 -1\n", submit: false }]],
		[
			"ctrl+v, ctrl+u, then kills that overflow the kill ring",
			[{ input: `kill -9 -1 ;\x16\x15${" a\x17".repeat(11)}\n`, submit: false }],
		],
		["an escape left open at Enter", [{ input: "kill -9 -1\x1b[" }]],
		[
			"a backslash continuation across two calls",
			[
				{ input: "kill -9 \\\n", submit: false },
				{ input: "-1\n", submit: false },
			],
		],
	] as const)("refuses a line built with %s", async (_shape, calls) => {
		const { harness, ran } = await setup();
		const outcomes: Outcome[] = [];
		for (const params of calls) outcomes.push(await call(harness, { bash_id: "b1", ...params }));

		const last = outcomes.at(-1);
		expect(last?.blocked).toBe(true);
		if (last?.blocked) expect(last.text).toContain("[senpi:kill-guard]");
		expect(outcomes.slice(0, -1)).toEqual(calls.slice(0, -1).map(() => ({ blocked: false })));
		expect(ran).toHaveLength(calls.length - 1);
	});

	it.each([
		["a plain line", [{ input: "ls -la\n", submit: false }]],
		["a plain line with backspaces", [{ input: "echo hi\x7f\x7fhello\n", submit: false }]],
		["an edited line with no kill-family word", [{ input: "ls\x01echo \n", submit: false }]],
		["an edited line without an i or two l", [{ input: "git pull --rebase\x01sudo \n", submit: false }]],
		["an edited line with k and i but no l", [{ input: "echo skip\x01x\n", submit: false }]],
		["tab completion of other words", [{ input: "git ch\t\n", submit: false }]],
		["tab completion after a k word that is no kill prefix", [{ input: "kubectl get po\t\n", submit: false }]],
		["a plain narrow kill", [{ input: "kill 4242\n", submit: false }]],
		[
			"a backslash continuation across two calls",
			[
				{ input: "echo a \\\n", submit: false },
				{ input: "b\n", submit: false },
			],
		],
	] as const)("lets %s through", async (_shape, calls) => {
		const { harness, ran } = await setup();
		const outcomes: Outcome[] = [];
		for (const params of calls) outcomes.push(await call(harness, { bash_id: "b1", ...params }));

		expect(outcomes).toEqual(calls.map(() => ({ blocked: false })));
		expect(ran).toHaveLength(calls.length);
	});
});

describe("kill guard keeps typed text for the life of each background session", () => {
	it("judges text typed before a session reload at the Enter after it", async () => {
		const { harness } = await setup();

		expect(await call(harness, { bash_id: "b1", input: "kill -9 ", submit: false })).toEqual({ blocked: false });
		await harness.session.reload();
		const enter = await call(harness, { bash_id: "b1", input: "-1" });

		expect(enter.blocked).toBe(true);
	});

	it("drops typed text only when its background session ends", async () => {
		const { harness, running } = await setup();
		running(["b1", "b2"]);
		await call(harness, { bash_id: "b1", input: "kill -9 ", submit: false });
		await call(harness, { bash_id: "b2", input: "kill -9 ", submit: false });

		running(["b2"]);

		expect(await call(harness, { bash_id: "b1", input: "-1" })).toEqual({ blocked: false });
		expect((await call(harness, { bash_id: "b2", input: "-1" })).blocked).toBe(true);
	});
});
