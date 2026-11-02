import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { type FrozenAcceptedRoot, SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { type RpcSessionEntry, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { EVENT_SAFETY_MS } from "./4272-worker-acceptance-support.ts";
import { FLAG } from "./5331-live-identity-support.ts";
import { writeSession } from "./5374-call-key-fixture-support.ts";

// RULING-127 (#5394 conformance): an old session (keyless blocks) continued live, where a new keyed call reuses an old
// block's toolCallId. A reader rebuilds the old block's row by toolCallId (it has no key) and the new call's row by its
// key: two rows, never merged. The old entries stay keyless and unchanged in the file and in the transcript a peer
// recovers, the snapshot holds only the new call, and the new result is keyed to the new call, not to the old block.

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Entry = { type?: string; id?: string; runtimeItemKey?: string; callUnknown?: boolean; message?: Message };
type Message = {
	role?: string;
	toolCallId?: string;
	content?: { type?: string; id?: string; runtimeItemKey?: string }[];
};
type Cut = { readonly lane: SessionAcceptanceLane; readonly root: FrozenAcceptedRoot; readonly type: string };

const OLD_IDS = ["a1", "r1", "r2", "r3"];
const toolCallParts = (entries: readonly Entry[]) =>
	entries.flatMap((entry) =>
		entry.message?.role === "assistant"
			? (entry.message.content ?? [])
					.filter((part) => part.type === "toolCall")
					.map((part) => ({ entry: entry.id, ...part }))
			: [],
	);

it("RULING-127 #5374 an old keyless block and a new keyed call reusing its toolCallId stay two rows, never merged", async () => {
	vi.stubEnv(FLAG, "1");
	const cuts: Cut[] = [];
	const laneAccept = SessionAcceptanceLane.prototype.accept;
	vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
		this: SessionAcceptanceLane,
		...args: Parameters<SessionAcceptanceLane["accept"]>
	) {
		const ref = laneAccept.apply(this, args);
		const type = "type" in args[0] ? String(args[0].type) : "";
		const role = "message" in args[0] ? (args[0].message as { role?: string } | undefined)?.role : undefined;
		if (ref && (type === "tool_execution_start" || (type === "message_end" && role === "toolResult")))
			cuts.push({ lane: this, root: this.freeze(), type });
		return ref;
	});
	await using host = await statusHost();
	await writeFile(join(host.cwd, "note.txt"), "note body\n");
	const sessionPath = writeSession(host.cwd, false, "old.jsonl");
	const oldBytes = readFileSync(sessionPath, "utf8").trim().split("\n").slice(1);
	const isOld = (line: string) => OLD_IDS.includes(String((JSON.parse(line) as Entry).id));
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const legacy = host.client("legacy");
	const routing = String(dataOf(await legacy.request({ type: "open_session", cwd: host.cwd, sessionPath })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	admissions.mockRestore();
	const lane = entry?.acceptance ?? expect.unreachable("no acceptance lane with the flag on");
	const compact = host.client("compact");
	host.writer.setConnectionCapabilities("compact", ["compact_events"]);
	host.writer.attachConnectionToSession("compact", routing);
	host.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }, { id: "solo" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("read it"),
	]);
	const done = legacy.waitFor(
		(record) => record.type === "agent_idle" && record.sessionId === routing,
		EVENT_SAFETY_MS,
	);
	dataOf(await legacy.request({ type: "prompt", sessionId: routing, message: "read again" }));
	await done;
	await host.writer.flush();
	vi.restoreAllMocks();

	const live = compact.inbox.find((record: WireRecord) => record.type === "tool_execution_start")?.runtimeItemKey;
	expect(live).toMatch(/^blk:[0-9a-f-]{36}:0$/);
	const started = cuts.find((cut) => cut.type === "tool_execution_start") ?? expect.unreachable("no start cut");
	const settledCut = cuts.find((cut) => cut.type === "message_end") ?? expect.unreachable("no result cut");
	const snapshot = await started.lane.readCurrentCalls(started.root);
	const settled = (await settledCut.lane.readSettled(settledCut.root)).settledMessages.filter(
		(row) => row.role === "toolResult",
	);
	for (const cut of cuts) cut.lane.release(cut.root);
	expect(snapshot.calls.map((call) => [call.toolCallId, call.runtimeItemKey])).toEqual([["solo", live]]);
	expect(settled.map((row) => row.runtimeItemKey)).toEqual([live]);

	const file = (entry?.runtime?.session.sessionManager.getSessionFile() ?? expect.unreachable("no file")) as string;
	const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
	expect(lines.filter(isOld), "the old entries' bytes in the file").toEqual(oldBytes);
	const persisted = lines.map((line) => JSON.parse(line) as Entry);
	const solo = toolCallParts(persisted).filter((part) => part.id === "solo");
	expect(solo.map((part) => part.runtimeItemKey)).toEqual([undefined, live]);
	const newResults = persisted.filter(
		(line) => line.message?.role === "toolResult" && !OLD_IDS.includes(String(line.id)),
	);
	expect(
		newResults.map((line) => [line.message?.toolCallId, line.runtimeItemKey ?? null, line.callUnknown ?? null]),
	).toEqual([["solo", live, null]]);

	const root = lane.freeze();
	try {
		const read = await readTranscriptRoot(root.transcript);
		if (!read.ok) throw new Error(`transcript read failed: ${read.error}`);
		const transcript = read.entries as readonly Entry[];
		const reserialized = transcript.map((line) => JSON.stringify(line)).filter(isOld);
		expect(reserialized, "the old entries' bytes in the transcript").toEqual(oldBytes);
		expect(
			toolCallParts(transcript)
				.filter((part) => part.id === "solo")
				.map((part) => part.runtimeItemKey),
		).toEqual([undefined, live]);
	} finally {
		lane.release(root);
	}
}, 600_000);
