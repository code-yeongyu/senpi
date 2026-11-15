// senpi#6754 (ST, review L2): a headless engine session whose tools run on a chosen hand carries its session to that
// hand on the shipped path (`headlessHostOptions` -> hand selection), so its session tools run there with the session's
// facts and their writes land in the engine's own session, as the same tools write it locally.
import { afterEach, describe, expect, it } from "vitest";
import { TODO_STATE_ENTRY_TYPE } from "../../src/core/extensions/builtin/todotools/todo-types.ts";
import type { HandRow } from "../../src/modes/headless/hand-selection.ts";
import { cleanupHands, handDirs, openLink, startHand, toolCall } from "../hand/remote-hand-fixture.ts";
import { type HostRig, startHostRig } from "./headless-host-support.ts";

const rigs: HostRig[] = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.dispose();
	await cleanupHands();
});

const ROW: HandRow = { device: "dev-b", label: "Studio", platform: "linux", reachable: true };

describe("a headless session's session tools on its chosen hand (senpi#6754)", () => {
	it("a todo call on the chosen hand writes its list into the engine's session", async () => {
		const dirs = await handDirs("hand-session-port");
		const rig = await startHostRig(
			"headless",
			{},
			{
				hands: {
					list: () => [ROW],
					link: () => {
						const link = openLink();
						startHand(link, dirs, []);
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

		const { messages } = await host.execute(
			{
				scope: { id: `scope-${crypto.randomUUID()}`, root: rig.root },
				calls: [toolCall("t1", "todo", { op: "init", list: [{ phase: "Ship", items: ["tag the build"] }] })],
				mode: "sequential",
			},
			{ emit: () => {} },
		);

		const [result] = messages;
		expect(result?.isError, JSON.stringify(result?.content)).toBe(false);
		const lists = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE);
		expect(lists).toHaveLength(1);
		expect(JSON.stringify(lists[0])).toContain("tag the build");
	}, 90_000);
});
