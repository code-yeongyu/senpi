// senpi#3566 todo 4: under the child runtime, a child-placed tool with a file-backed body dispatches as a `module` job
// through the injected runner; everything else keeps its explicit behavior (server or tool_runtime_unavailable).
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import {
	ChildToolDispatcher,
	TOOL_RUNTIME_UNAVAILABLE,
	type ToolChildModuleJob,
	type ToolChildRunner,
	type ToolDispatchedInfo,
} from "./tool-dispatcher.ts";

const unusedContext = new Proxy(
	{},
	{
		get: (_target, key) => {
			throw new Error(`the child path must not touch ctx.${String(key)}`);
		},
	},
) as ExtensionToolContext;

function definition(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name: "probe",
		label: "probe",
		description: "probe",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "in-process" }], details: undefined }),
		...overrides,
	};
}

function recordingRunner(value: unknown): { runner: ToolChildRunner; jobs: ToolChildModuleJob[] } {
	const jobs: ToolChildModuleJob[] = [];
	return {
		jobs,
		runner: async (job) => {
			jobs.push(job);
			return { value, pid: 4242, generation: 3 };
		},
	};
}

function call(def: ToolDefinition, sourcePath?: string) {
	return {
		definition: def,
		toolCallId: "call-1",
		params: { n: 1 },
		ctx: unusedContext,
		...(sourcePath === undefined ? {} : { sourcePath }),
	};
}

describe("ChildToolDispatcher with a child runner", () => {
	it("runs a child-placed tool's file-backed body as a module job and reports the child's pid and generation", async () => {
		const result = { content: [{ type: "text", text: "from child" }], details: { ok: true } };
		const { runner, jobs } = recordingRunner(result);
		const dispatcher = new ChildToolDispatcher(undefined, runner);
		const dispatched: ToolDispatchedInfo[] = [];
		dispatcher.onDispatched((info) => dispatched.push(info));
		const def = definition({ placement: "child", childModule: { path: "./body.ts", export: "run" } });
		expect(await dispatcher.run(call(def, "/ext/dir/index.ts"))).toEqual(result);
		expect(jobs).toEqual([
			{ modulePath: "/ext/dir/body.ts", export: "run", args: { params: { n: 1 }, toolCallId: "call-1" } },
		]);
		expect(dispatched).toEqual([{ toolCallId: "call-1", placement: "child", pid: 4242, generation: 3 }]);
	});

	it("never falls back to in-process: no runner or no childModule gives tool_runtime_unavailable", async () => {
		const withModule = definition({ placement: "child", childModule: { path: "/abs/body.ts", export: "run" } });
		const noRunner = await new ChildToolDispatcher().run(call(withModule));
		expect(noRunner.isError).toBe(true);
		expect(noRunner.details).toEqual({ code: TOOL_RUNTIME_UNAVAILABLE });
		const { runner, jobs } = recordingRunner({ content: [] });
		const noModule = await new ChildToolDispatcher(undefined, runner).run(call(definition({ placement: "child" })));
		expect(noModule.details).toEqual({ code: TOOL_RUNTIME_UNAVAILABLE });
		const relativeWithoutSource = definition({
			placement: "child",
			childModule: { path: "./body.ts", export: "run" },
		});
		const unresolved = await new ChildToolDispatcher(undefined, runner).run(call(relativeWithoutSource));
		expect(unresolved.details).toEqual({ code: TOOL_RUNTIME_UNAVAILABLE });
		expect(jobs).toEqual([]);
	});

	it("keeps server-placed and server-pinned tools on the server", async () => {
		const { runner, jobs } = recordingRunner({ content: [] });
		const dispatcher = new ChildToolDispatcher(undefined, runner);
		const pinned = definition({
			placement: "child",
			serverPinned: true,
			childModule: { path: "/abs/b.ts", export: "run" },
		});
		expect((await dispatcher.run(call(pinned))).content).toEqual([{ type: "text", text: "in-process" }]);
		expect((await dispatcher.run(call(definition()))).content).toEqual([{ type: "text", text: "in-process" }]);
		expect(jobs).toEqual([]);
	});

	it("rejects a child result that is not a tool result", async () => {
		const { runner } = recordingRunner({ nope: true });
		const def = definition({ placement: "child", childModule: { path: "/abs/body.ts", export: "run" } });
		await expect(new ChildToolDispatcher(undefined, runner).run(call(def))).rejects.toThrow(
			/tool_child_invalid_result/,
		);
	});
});
