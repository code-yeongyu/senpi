// S32 (brain/hand split, senpi#5641): on a split session the tools declared `runs: "brain"` run where the loop runs
// and never reach the hand, a hand-run tool reaches them over the session plane, and a thread chain (A→B→A…) is limited
// only by a count the user sets (K8): unset means unlimited, and there is no cost limit.
import {
	admitChainCall,
	CHAIN_COUNT_LIMIT,
	ChainCountLimitError,
	createRemoteToolHost,
	createSessionPlaneClient,
	createSplitToolHost,
	decodeChainCount,
	loopSideToolNames,
	nextChainCount,
	PlaneRefusedError,
	SESSION_PLANE,
	serveSessionPlane,
	type ToolHost,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { TodoToolDetails } from "../../src/core/extensions/builtin/todotools/state.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { openLink, startHandOn } from "../hand/remote-hand-fixture.ts";
import { call, cleanups, recordingHost, scratch, shippedSession, texts } from "./session-plane-fixture.ts";

// Q's split (2026-11-03): todo is loop-side; file access and shell are the hand's.
const LOOP_BY_RULING = ["todo", "web_search", "webfetch"];
const HAND_BY_RULING = ["read", "write", "edit", "bash", "grep", "find", "ls"];

describe("session plane (S32): session tools run where the loop runs", () => {
	it("routes every shipped tool declared loop-side to the loop and every other tool to the hand", async () => {
		const { definitions } = await shippedSession();
		const loopSide = loopSideToolNames(definitions);
		const names = definitions.map((definition) => definition.name);
		const ran: string[] = [];
		const host = createSplitToolHost({
			loopSide: (name) => loopSide.has(name),
			loop: recordingHost("loop", ran),
			hand: recordingHost("hand", ran),
		});
		const calls = names.map((name, index) => call(`c${index}`, name));

		const { messages } = await host.execute(
			{ scope: { id: "s32", root: "/work" }, calls, mode: "parallel" },
			{ emit: () => {} },
		);

		for (const name of LOOP_BY_RULING) expect(loopSide.has(name), name).toBe(true);
		for (const name of HAND_BY_RULING) expect(names, name).toContain(name);
		for (const name of HAND_BY_RULING) expect(loopSide.has(name), name).toBe(false);
		expect(ran.filter((entry) => entry.startsWith("loop:"))).toEqual(
			names.filter((name) => loopSide.has(name)).map((name) => `loop:${name}`),
		);
		expect(ran.filter((entry) => entry.startsWith("hand:"))).toEqual(
			names.filter((name) => !loopSide.has(name)).map((name) => `hand:${name}`),
		);
		expect(messages.map((message) => message.toolCallId)).toEqual(calls.map((raw) => raw.id));
	}, 60_000);

	it("runs a sequential mixed batch side by side in source order, a repeated call ID included", async () => {
		const ran: string[] = [];
		const host = createSplitToolHost({
			loopSide: (name) => name === "todo",
			loop: recordingHost("loop", ran),
			hand: recordingHost("hand", ran),
		});
		const calls = [call("a", "read"), call("dup", "todo"), call("dup", "bash"), call("d", "todo")];

		const { messages, terminate } = await host.execute(
			{ scope: { id: "s32", root: "/work" }, calls, mode: "sequential" },
			{ emit: () => {} },
		);

		expect(ran).toEqual(["hand:read", "loop:todo", "hand:bash", "loop:todo"]);
		expect(texts(messages)).toEqual(["hand:read", "loop:todo", "hand:bash", "loop:todo"]);
		expect(terminate).toBe(false);
	});

	it("serves a hand-run tool's todo call on the brain's own session, and refuses a hand tool on the plane", async () => {
		const { session, definitions } = await shippedSession();
		const loopSide = loopSideToolNames(definitions);
		const link = openLink();
		const outcomes: string[] = [];
		startHandOn(link, async () => ({
			run: async (handCall) => {
				const plane = createSessionPlaneClient(handCall.nested);
				const tool = handCall.name === "plan_from_hand" ? "todo" : "read";
				try {
					const result = await plane.call(
						{ tool, arguments: { op: "init", list: [{ phase: "Hand", items: ["made on the hand"] }] } },
						handCall.signal,
					);
					outcomes.push(`ok:${tool}`);
					return result;
				} catch (error) {
					outcomes.push(error instanceof PlaneRefusedError ? `refused:${error.reason}` : String(error));
					return { content: [{ type: "text", text: "refused" }], details: {}, isError: true };
				}
			},
			isSequential: () => false,
			dispose: async () => {},
		}));
		const brain = createSplitToolHost({
			loopSide: (name) => loopSide.has(name),
			loop: recordingHost("loop", []),
			hand: handHostServingSessionPlane(link, loopSide, session),
		});

		await brain.execute(
			{
				scope: { id: "s32-plane", root: "/work" },
				calls: [call("p", "plan_from_hand"), call("r", "read_via_plane")],
				mode: "sequential",
			},
			{ emit: () => {} },
		);

		expect(outcomes).toEqual(["ok:todo", "refused:plane_failed: not_loop_side: read"]);
		const view = await session.getRegisteredTool("todo")?.execute("view", { op: "view" }, undefined, undefined);
		expect((view?.details as TodoToolDetails | undefined)?.phases).toEqual([
			{ name: "Hand", tasks: [{ content: "made on the hand", status: "in_progress" }] },
		]);
	}, 60_000);
});

function handHostServingSessionPlane(
	link: ReturnType<typeof openLink>,
	loopSide: ReadonlySet<string>,
	session: Awaited<ReturnType<typeof shippedSession>>["session"],
): ToolHost {
	const host = createRemoteToolHost({
		transport: link.brain,
		placement: "split-local",
		planes: {
			[SESSION_PLANE]: serveSessionPlane({
				loopSide,
				run: async (request, signal) => {
					const tool = session.getRegisteredTool(request.tool);
					if (tool === undefined) throw new Error(`no tool ${request.tool}`);
					return tool.execute(`plane-${request.tool}`, request.arguments, signal, undefined);
				},
			}),
		},
	});
	cleanups.push(async () => host.close());
	return host;
}

describe("thread chain count (K8): user-set, unlimited by default, no cost limit", () => {
	function chain(settings: SettingsManager, route: readonly string[]): string[] {
		const admitted: string[] = [];
		let count = decodeChainCount(undefined);
		for (const session of route) {
			admitChainCall(count, () => settings.getThreadChainCountLimit());
			admitted.push(`${session}@${count}`);
			count = nextChainCount(count);
		}
		return admitted;
	}
	const settingsFrom = async (settings?: Record<string, unknown>): Promise<SettingsManager> => {
		const { cwd, agentDir } = await scratch(settings);
		return SettingsManager.create(cwd, agentDir);
	};

	it("admits A→B→A: a chain may come back to the session it started from", async () => {
		expect(chain(await settingsFrom(), ["B", "A"])).toEqual(["B@1", "A@2"]);
	});

	it("never refuses a 12-hop chain when the user set no count limit (the shipped default)", async () => {
		const settings = await settingsFrom({ defaultTools: ["read"] });
		const route = Array.from({ length: 12 }, (_, hop) => (hop % 2 === 0 ? "B" : "A"));

		expect(settings.getThreadChainCountLimit()).toBeUndefined();
		expect(chain(settings, route)).toHaveLength(12);
	});

	it("refuses call N+1 when the user set a count limit N in the settings file", async () => {
		const settings = await settingsFrom({ threads: { chainCountLimit: 3 } });
		const route = ["B", "A", "B", "A"];

		let refused: unknown;
		const admitted: string[] = [];
		try {
			admitted.push(...chain(settings, route.slice(0, 3)));
			chain(settings, route);
		} catch (error) {
			refused = error;
		}

		expect(admitted).toEqual(["B@1", "A@2", "B@3"]);
		expect(refused).toBeInstanceOf(ChainCountLimitError);
		expect(refused).toMatchObject({ reason: CHAIN_COUNT_LIMIT, count: 4, limit: 3 });
	});
});
