import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { expectOneNumbering, recordFolds } from "./4272-compact-lane-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// senpi#4272 S03b-3 (RULING-26 Q2, RULING-39, #4425 LOW 3/4): the real in-process binding folds each canonical
// record with its legacy record in one lane step, at the lane's own sequence, with no peer selecting compact output.
it("T6 Q2 in-process canonical records fold with their legacy record at one lane sequence", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const folds = recordFolds();
	const laneSequences: number[] = [];
	const laneAccept = SessionAcceptanceLane.prototype.accept;
	vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
		this: SessionAcceptanceLane,
		...args: Parameters<SessionAcceptanceLane["accept"]>
	) {
		const ref = laneAccept.apply(this, args);
		if (ref) laneSequences.push(ref.sequence);
		return ref;
	});
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("lane");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	const session = entry?.runtime?.session;
	if (!lane || !session) throw new Error("no real lane");
	host.faux.setResponses([fauxAssistantMessage("answer first", { timestamp: 1 })]);
	const done = client.waitFor((record) => record.type === "agent_idle");
	dataOf(await client.request({ type: "prompt", sessionId, message: "first" }));
	await done;
	await session.sendCustomMessage({
		customType: "note",
		content: "n",
		display: true,
		details: { kept: 1, nested: { dropped: undefined } },
	});
	await host.writer.flush();
	expectOneNumbering(folds, lane.recoveryEpoch);
	expect(folds.some(({ t }) => t.type === "seeded_block")).toBe(true);
	for (const fold of folds.filter((each) => each.t.type === "seeded_message"))
		expect(laneSequences).toContain(fold.sequence);
	await lane.idle();
	const root = lane.freeze();
	try {
		expect(root.current?.sequence).toBe(folds.at(-1)?.sequence);
		const { messages } = await lane.readCurrent(root);
		const role = (name: string) => messages.find((message) => message.message?.role === name);
		// S03b-3b: the owned append of the user message settles its compact persistence after acceptance.
		expect(role("user")).toMatchObject({ persistence: "appended" });
		expect(
			role("assistant")
				?.blocks.map((block) => block.text)
				.join(""),
		).toContain("first");
		// Select the test's own note: the session also carries other custom messages (workstation facts).
		const note = messages.find((message) => message.message?.customType === "note");
		expect(note?.message).toMatchObject({ details: { kept: 1, nested: {} } });
	} finally {
		lane.release(root);
	}
	expect(JSON.stringify(client.inbox)).not.toMatch(/invalidatedBlocks|firstOrdinal|message_block_state/);
}, 60000);
