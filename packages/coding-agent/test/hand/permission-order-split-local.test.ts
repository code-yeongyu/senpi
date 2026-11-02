// S27a (K3.b, senpi#5413 deferred obligation): a call that reaches a hand runs the hand's extensions' tool_call
// handlers (permission checks among them) before the tool and the tool_result handlers after it, in registration order,
// as a session runs them. A handler that blocks or throws stops the call before the tool runs (fail-closed).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import {
	cleanupHands,
	handDirs,
	openLink,
	remoteHost,
	runTurn,
	startHand,
	toolCall,
	toolResultTexts,
} from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

function tracedTool(trace: string[]) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "probe",
			label: "Probe",
			description: "Records that it ran.",
			parameters: Type.Object({ value: Type.Number() }),
			async execute(_toolCallId, params) {
				trace.push(`body:${params.value}`);
				return { content: [{ type: "text", text: `ran ${params.value}` }], details: {} };
			},
		});
	};
}

function tracedHandlers(trace: string[], name: string) {
	return (pi: ExtensionAPI): void => {
		pi.on("tool_call", (event) => {
			trace.push(`tool_call:${name}`);
			const input = event.input as { value?: number };
			if (input.value === 13) return { block: true, reason: `${name} refused 13` };
			if (input.value === 7) throw new Error(`${name} handler failed`);
			if (input.value === 5) input.value = 6;
			return undefined;
		});
		pi.on("tool_result", (event) => {
			trace.push(`tool_result:${name}`);
			return name === "b"
				? { content: [{ type: "text", text: `${JSON.stringify(event.content)} seen by b` }] }
				: undefined;
		});
	};
}

async function remoteCall(value: number) {
	const trace: string[] = [];
	const dirs = await handDirs("order");
	const link = openLink();
	startHand(link, dirs, [tracedTool(trace), tracedHandlers(trace, "a"), tracedHandlers(trace, "b")]);
	const { agent } = await runTurn({
		calls: [toolCall("call-1", "probe", { value })],
		toolHost: remoteHost(link),
		root: dirs.cwd,
	});
	return {
		trace,
		results: toolResultTexts(agent),
		isError: agent.state.messages.find((m) => m.role === "toolResult")?.isError,
	};
}

describe("hand-side tool handlers on split-local (S27a, K3.b)", () => {
	it("runs tool_call handlers before the tool and tool_result handlers after it, in registration order", async () => {
		const run = await remoteCall(1);

		expect(run.trace).toEqual(["tool_call:a", "tool_call:b", "body:1", "tool_result:a", "tool_result:b"]);
		expect(run.results).toEqual(['[{"type":"text","text":"ran 1"}] seen by b']);
	});

	it("lets a tool_call handler rewrite the arguments the tool receives", async () => {
		const run = await remoteCall(5);

		expect(run.trace).toEqual(["tool_call:a", "tool_call:b", "body:6", "tool_result:a", "tool_result:b"]);
	});

	it("stops a call a tool_call handler blocks before the tool or any later handler runs", async () => {
		const run = await remoteCall(13);

		expect(run.trace).toEqual(["tool_call:a"]);
		expect(run.results).toEqual(["a refused 13"]);
		expect(run.isError).toBe(true);
	});

	it("refuses a call whose tool_call handler throws, running nothing (fail-closed)", async () => {
		const run = await remoteCall(7);

		expect(run.trace).toEqual(["tool_call:a"]);
		expect(run.results).toEqual(["a handler failed"]);
		expect(run.isError).toBe(true);
	});

	it("refuses every call on a hand whose configuration has tool hooks, which need a session (fail-closed)", async () => {
		const trace: string[] = [];
		const dirs = await handDirs("shell-hooks");
		await mkdir(dirs.agentDir, { recursive: true });
		const hooks = { hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "true" }] }] } };
		await writeFile(join(dirs.agentDir, "hooks.json"), JSON.stringify(hooks));
		const link = openLink();
		startHand(link, dirs, [tracedTool(trace)]);

		const { agent } = await runTurn({
			calls: [toolCall("call-1", "probe", { value: 1 })],
			toolHost: remoteHost(link),
			root: dirs.cwd,
		});

		expect(trace).toEqual([]);
		expect(toolResultTexts(agent)).toEqual([
			"Tool hooks are configured, and this runtime has no session to run them with.",
		]);
	});

	it("judges a remote bash call with the builtin permission system as a fused session does", async () => {
		const dirs = await handDirs("permission");
		const notes = join(dirs.cwd, "notes.txt");
		await writeFile(notes, "keep me\n");
		const link = openLink();
		const permission = builtinExtensions
			.filter((entry) => entry.id === "permission-system")
			.map((entry) => ({ factory: entry.factory, path: `<builtin:${entry.id}>` }));
		startHand(link, dirs, permission, ["--permission-preset", "auto"]);

		const { agent } = await runTurn({
			calls: [
				toolCall("read", "bash", { command: "cat notes.txt" }),
				toolCall("delete", "bash", { command: "rm notes.txt" }),
			],
			toolHost: remoteHost(link),
			root: dirs.cwd,
			toolExecution: "sequential",
		});

		const [read, deleted] = toolResultTexts(agent);
		expect(read).toContain("keep me");
		expect(deleted).toContain("Permission required for bash");
		expect(await readFile(notes, "utf-8")).toBe("keep me\n");
	}, 30_000);
});
