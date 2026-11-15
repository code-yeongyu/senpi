// senpi#6754 (ST): a hosted loop registers no tool, so its session tools run on the user's machine with the same tool
// code as locally. The session lives in the loop: each call carries the loop's session facts (session port, read) and
// returns the writes the loop commits (session port, write), at the real boundary of a brain's remote ToolHost and a
// hand's loopless runtimes over an in-process carrier.
import {
	type AgentToolCall,
	createRemoteExecutor,
	createRemoteToolHost,
	type RemoteSessionPort,
} from "@earendil-works/pi-agent-core";
import type { JsonValue, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { TodoToolDetails } from "../../src/core/extensions/builtin/todotools/state.ts";
import { TODO_STATE_ENTRY_TYPE } from "../../src/core/extensions/builtin/todotools/todo-types.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { cleanupHands, handConfiguration, handDirs, type HandDirs, openLink } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

interface CommittedEffects {
	readonly entries?: { readonly customType: string; readonly data?: unknown }[];
	readonly activeTools?: string[];
}

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/**
 * The loop's side of the session port: its own branch (the user's request first), the facts it carries with every
 * call, and the commit of what a call returns. A real loop appends each entry to its log; this one to its branch.
 */
function hostedLoop(activeTools: string[]) {
	const sessionId = `hosted-${crypto.randomUUID()}`;
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "plan the release" }], timestamp: 0 },
		},
	];
	const loop = {
		sessionId,
		branch,
		activeTools,
		committed: [] as { readonly toolCallId: string; readonly effects: CommittedEffects }[],
	};
	const port: RemoteSessionPort = {
		carry: () =>
			toJson({
				sessionId,
				idle: false,
				leafId: branch.at(-1)?.id ?? null,
				handEntries: branch.filter((entry) => entry.type === "custom"),
				branch,
				activeTools: loop.activeTools,
			}),
		commit: (call: AgentToolCall, raw: JsonValue) => {
			const effects = raw as CommittedEffects;
			loop.committed.push({ toolCallId: call.id, effects });
			for (const entry of effects.entries ?? [])
				branch.push({
					type: "custom",
					id: `hand-${branch.length}`,
					parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date(0).toISOString(),
					customType: entry.customType,
					data: entry.data,
				});
			if (effects.activeTools !== undefined) loop.activeTools = effects.activeTools;
		},
	};
	return { loop, port };
}

/** One hand process on the user's machine and the brain's link to it; `extra` adds extensions beside the builtins. */
function userMachine(dirs: HandDirs, port: RemoteSessionPort, extra: ((pi: ExtensionAPI) => void)[] = []) {
	const link = openLink();
	const hand = createLooplessHand(handConfiguration(dirs), {
		twoSidedHome: "hand",
		...(extra.length === 0 ? {} : { extensionFactories: extra }),
	});
	const executor = createRemoteExecutor({
		authority: { kind: "self" },
		transport: link.hand,
		openScope: hand.openScope,
		onFault: (error) => {
			throw error;
		},
	});
	const host = createRemoteToolHost({ transport: link.brain, placement: "cross-machine", sessionPort: port });
	const scope = { id: `scope-${crypto.randomUUID()}`, root: dirs.cwd };
	return {
		call: async (id: string, name: string, args: Record<string, JsonValue>): Promise<ToolResultMessage> => {
			const { messages } = await host.execute(
				{ scope, calls: [{ type: "toolCall", id, name, arguments: args }], mode: "sequential" },
				{ emit: () => {} },
			);
			const [message] = messages;
			if (message === undefined) throw new Error(`no result for ${id}`);
			return message;
		},
		close: async () => {
			host.close();
			await executor.close();
			await hand.close();
		},
	};
}

const textOf = (message: ToolResultMessage): string =>
	message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

describe("a hosted loop's session tools run on the user's machine through the session port (senpi#6754)", () => {
	it("todo returns its list, the loop commits its entry, and a later call carrying that entry sees the list", async () => {
		const dirs = await handDirs("st-todo");
		const { loop, port } = hostedLoop(["read", "todo"]);
		const first = userMachine(dirs, port);

		const init = await first.call("t1", "todo", { op: "init", list: [{ phase: "Ship", items: ["tag the build"] }] });
		await first.close();
		// A fresh hand process: what it knows of the list is only what the loop carries.
		const second = userMachine(dirs, port);
		const view = await second.call("t2", "todo", { op: "view" });
		await second.close();

		expect(init.isError, textOf(init)).toBe(false);
		const details = init.details as TodoToolDetails;
		expect(details.phases.map((phase) => phase.name)).toEqual(["Ship"]);
		// The ask comes from the user's request the loop carried, as a local session reads it from its branch.
		expect(details.ask?.text).toBe("plan the release");
		expect(loop.committed.map(({ effects }) => effects.entries?.map((entry) => entry.customType))).toEqual([
			[TODO_STATE_ENTRY_TYPE],
			undefined,
		]);
		expect(view.isError, textOf(view)).toBe(false);
		expect((view.details as TodoToolDetails).phases).toEqual(details.phases);
		expect(textOf(view)).toContain("tag the build");
	}, 90_000);

	it("a deferred tool's first call activates it in the loop's tool set, and tool_search runs there", async () => {
		const dirs = await handDirs("st-search");
		const { loop, port } = hostedLoop(["read"]);
		const releaseNotes = (pi: ExtensionAPI) =>
			pi.registerTool({
				name: "release_notes",
				label: "Release notes",
				description: "Draft the release notes for a version.",
				exposure: "search",
				parameters: Type.Object({ version: Type.String() }),
				execute: async (_id, params) => ({
					content: [{ type: "text", text: `notes for ${params.version}` }],
					details: {},
				}),
			});
		const machine = userMachine(dirs, port, [releaseNotes]);

		const notes = await machine.call("n1", "release_notes", { version: "1.2.0" });
		const search = await machine.call("s1", "tool_search", { query: "draft release notes" });
		await machine.close();

		expect([notes.isError, textOf(notes)]).toEqual([false, "notes for 1.2.0"]);
		expect(loop.activeTools).toEqual(expect.arrayContaining(["read", "release_notes", "tool_search"]));
		expect(search.isError, textOf(search)).toBe(false);
		expect(textOf(search)).toContain("release_notes");
	}, 90_000);
});
