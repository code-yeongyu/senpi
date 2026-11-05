// DK2a engine half (R4): a headless engine lists the hands it can reach and records, per session, which one runs that
// session's tools. A chosen hand that cannot run them makes the calls fail; they never fall back to this process.
import { Agent, type ToolHost } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import {
	createHandSelection,
	HAND_SELECTION_ENTRY,
	type HandDirectory,
	type HandRow,
} from "../../src/modes/headless/hand-selection.ts";
import { cleanupHands, handDirs, openLink, startHand, toolCall } from "../hand/remote-hand-fixture.ts";
import { type HostRig, startHostRig } from "./headless-host-support.ts";

const rigs: HostRig[] = [];
afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.dispose();
	await cleanupHands();
});

const ranOnHand: string[] = [];
function handTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Reports where it ran.",
		parameters: Type.Object({ value: Type.Number() }),
		async execute(toolCallId, params) {
			ranOnHand.push(toolCallId);
			return { content: [{ type: "text", text: `hand ${params.value}` }], details: {} };
		},
	});
}

const ROW: HandRow = { device: "dev-b", label: "Studio", platform: "linux", reachable: true };

async function handDirectory(rows: readonly HandRow[]): Promise<HandDirectory> {
	const dirs = await handDirs("select-hand");
	const link = openLink();
	startHand(link, dirs, [handTools]);
	return { list: () => rows, link: () => ({ transport: link.brain, placement: "split-local" }) };
}

async function rigWith(hands: HandDirectory | undefined): Promise<HostRig> {
	const rig = await startHostRig("headless", {}, hands === undefined ? {} : { hands });
	rigs.push(rig);
	rig.connect("a");
	return rig;
}

async function call(rig: HostRig, command: Record<string, unknown>) {
	const id = `cmd-${crypto.randomUUID()}`;
	await rig.send("a", { ...command, id });
	return rig.response(id);
}

async function runProbe(host: ToolHost | undefined, root: string): Promise<readonly string[]> {
	if (host === undefined) throw new Error("the session has no ToolHost: its tools run in this process");
	const { messages } = await host.execute(
		{
			scope: { id: `scope-${crypto.randomUUID()}`, root },
			calls: [toolCall("c1", "probe", { value: 7 })],
			mode: "parallel",
		},
		{ emit: () => {} },
	);
	return messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
}

describe("hand selection on a headless engine (DK2a engine half, R4)", () => {
	it("advertises hand_selection only with a hand directory; without one the commands are refused", async () => {
		const plain = await rigWith(undefined);
		const info = await call(plain, { type: "get_protocol_info" });
		expect(Reflect.get(Object(info.data), "capabilities")).not.toContain("hand_selection");
		expect(await call(plain, { type: "list_hands" })).toMatchObject({
			success: false,
			error: "hand_selection_unsupported",
		});

		const withHands = await rigWith(await handDirectory([ROW]));
		const advertised = await call(withHands, { type: "get_protocol_info" });
		expect(Reflect.get(Object(advertised.data), "capabilities")).toContain("hand_selection");
	});

	it("lists the directory's hands and a fresh session's choice as local", async () => {
		const rig = await rigWith(await handDirectory([ROW, { ...ROW, device: "dev-c", reachable: false }]));
		const sessionId = await rig.openSession("a", await rig.newSessionFile());

		expect(await call(rig, { type: "list_hands", sessionId })).toMatchObject({
			success: true,
			data: {
				hands: [ROW, { ...ROW, device: "dev-c", reachable: false }],
				selected: null,
			},
		});
	});

	it("runs a session's tool calls on the chosen hand, records the choice, and returns to local on null", async () => {
		ranOnHand.length = 0;
		const rig = await rigWith(await handDirectory([ROW]));
		const sessionId = await rig.openSession("a", await rig.newSessionFile());
		const session = rig.sessions[0];
		if (session === undefined) throw new Error("no session runtime");
		const fused = session.agent.toolHost;

		expect(await call(rig, { type: "select_hand", sessionId, device: "dev-b" })).toMatchObject({
			success: true,
			data: { sessionId, selected: "dev-b" },
		});
		expect(await runProbe(session.agent.toolHost, rig.root)).toEqual(["hand 7"]);
		expect(ranOnHand).toEqual(["c1"]);
		expect(await call(rig, { type: "list_hands", sessionId })).toMatchObject({ data: { selected: "dev-b" } });
		const recorded = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === HAND_SELECTION_ENTRY)
			.map((entry) => (entry.type === "custom" ? entry.data : undefined));
		expect(recorded).toEqual([{ device: "dev-b" }]);

		expect(await call(rig, { type: "select_hand", sessionId, device: null })).toMatchObject({
			success: true,
			data: { selected: null },
		});
		expect(session.agent.toolHost).toBe(fused);
	});

	it("refuses a hand that is not listed or not reachable, naming it, and changes nothing", async () => {
		const rig = await rigWith(await handDirectory([{ ...ROW, reachable: false }]));
		const sessionId = await rig.openSession("a", await rig.newSessionFile());
		const session = rig.sessions[0];
		const fused = session?.agent.toolHost;

		expect(await call(rig, { type: "select_hand", sessionId, device: "dev-x" })).toMatchObject({
			success: false,
			error: "hand_not_listed",
			errorData: { device: "dev-x" },
		});
		expect(await call(rig, { type: "select_hand", sessionId, device: "dev-b" })).toMatchObject({
			success: false,
			error: "hand_unreachable",
			errorData: { device: "dev-b" },
		});
		expect(session?.agent.toolHost).toBe(fused);
		expect(await call(rig, { type: "list_hands", sessionId })).toMatchObject({ data: { selected: null } });
	});

	it("a recorded hand that is gone when the session reopens fails its calls; nothing runs in this process", async () => {
		ranOnHand.length = 0;
		const entries: SessionEntry[] = [
			{
				type: "custom",
				id: "e1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: HAND_SELECTION_ENTRY,
				data: { device: "dev-b" },
			},
		];
		const ranLocally: string[] = [];
		const agent = new Agent({
			streamFn: () => {
				throw new Error("no model turn runs in this case");
			},
			initialState: {
				tools: [
					{
						name: "probe",
						label: "probe",
						description: "local probe",
						parameters: Type.Object({ value: Type.Number() }),
						execute: async (toolCallId) => {
							ranLocally.push(toolCallId);
							return { content: [{ type: "text", text: "local" }], details: {} };
						},
					},
				],
			},
		});
		const selection = createHandSelection({
			list: () => [],
			link: () => {
				throw new Error("an unlisted hand is never linked");
			},
		});

		selection.restore("durable-1", {
			agent,
			sessionManager: { getEntries: () => entries, appendCustomEntry: () => "unused" },
		});

		expect(selection.selected("durable-1")).toBe("dev-b");
		const texts = await runProbe(agent.toolHost, "/");
		expect(texts).toHaveLength(1);
		expect(texts[0]).toContain("unreachable");
		expect(ranLocally).toEqual([]);
		expect(ranOnHand).toEqual([]);
	});
});
