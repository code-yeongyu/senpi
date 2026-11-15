// senpi#6754 (ST, review L2/L3/L4 on #6762): a headless engine session whose tools run on a chosen hand carries its
// session to that hand on the shipped path (`headlessHostOptions` -> hand selection), but only for the tools whose
// subject is the session; their writes land in the engine's own session, and attached clients see them as they see a
// local `pi.appendEntry`.
import type { HandScope, OpenHandScope } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { TODO_STATE_ENTRY_TYPE } from "../../src/core/extensions/builtin/todotools/todo-types.ts";
import type { HandRow } from "../../src/modes/headless/hand-selection.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import {
	cleanupHands,
	handConfiguration,
	handDirs,
	openLink,
	startHandOn,
	toolCall,
} from "../hand/remote-hand-fixture.ts";
import { type HostRig, startHostRig } from "./headless-host-support.ts";

const rigs: HostRig[] = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.dispose();
	await cleanupHands();
});

const ROW: HandRow = { device: "dev-b", label: "Studio", platform: "linux", reachable: true };

describe("a headless session's session tools on its chosen hand (senpi#6754)", () => {
	it("only session tools carry the session; a todo call's list lands in the engine's session, told to clients", async () => {
		const dirs = await handDirs("hand-session-port");
		const carried: [string, boolean, string | undefined][] = [];
		const hand = createLooplessHand(handConfiguration(dirs));
		const recording: OpenHandScope = async (scope) => {
			const inner: HandScope = await hand.openScope(scope);
			return {
				...inner,
				run: (call) => {
					carried.push([call.name, call.session !== undefined, call.sessionId]);
					return inner.run(call);
				},
			};
		};
		const rig = await startHostRig(
			"headless",
			{},
			{
				hands: {
					list: () => [ROW],
					link: () => {
						const link = openLink();
						startHandOn(link, recording);
						return { transport: link.brain, placement: "cross-machine" };
					},
				},
			},
		);
		rigs.push(rig);
		rig.connect("a");
		const sessionId = await rig.openSession("a", await rig.newSessionFile());
		const session = rig.sessions[0];
		if (session === undefined) throw new Error("no session runtime");
		await rig.send("a", { id: "select", type: "select_hand", sessionId, device: "dev-b" });
		expect(await rig.response("select")).toMatchObject({ success: true });
		const host = session.agent.toolHost;
		if (host === undefined) throw new Error("the chosen hand installed no ToolHost");
		const appended: string[] = [];
		session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "custom") appended.push(event.entry.customType);
		});

		const { messages } = await host.execute(
			{
				scope: { id: `scope-${crypto.randomUUID()}`, root: rig.root },
				calls: [
					toolCall("b1", "bash", { command: "true" }),
					toolCall("t1", "todo", { op: "init", list: [{ phase: "Ship", items: ["tag the build"] }] }),
				],
				mode: "sequential",
			},
			{ emit: () => {} },
		);
		await hand.close();

		// Every call names the session (identity); only the session tool carries its record.
		expect(carried).toEqual([
			["bash", false, session.sessionId],
			["todo", true, session.sessionId],
		]);
		expect(messages[1]?.isError, JSON.stringify(messages[1]?.content)).toBe(false);
		const lists = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE);
		expect(lists).toHaveLength(1);
		expect(JSON.stringify(lists[0])).toContain("tag the build");
		expect(appended).toEqual([TODO_STATE_ENTRY_TYPE]);
	}, 90_000);
});
