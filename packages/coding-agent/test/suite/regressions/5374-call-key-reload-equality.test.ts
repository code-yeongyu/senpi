import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { FileEntry } from "../../../src/core/session-manager.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { type FrozenAcceptedRoot, SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { type RpcSessionEntry, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { EVENT_SAFETY_MS } from "./4272-worker-acceptance-support.ts";
import { FLAG } from "./5331-live-identity-support.ts";

// RULING-126 (3) and RULING-127 (i), (d) (senpi#5374): one identity source. The key a compact peer's live record names,
// the key of the call's settled snapshot row, the key the session file holds on the toolCall part and on the toolResult
// entry are one key, and after a reload the transcript a recovering peer reads carries that same key, reused, not minted.

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Entry = { type?: string; runtimeItemKey?: string; message?: { role?: string; content?: unknown } };
const keyOfPart = (entry: Entry | undefined) =>
	(entry?.message?.content as { type?: string; runtimeItemKey?: string }[] | undefined)?.find(
		(part) => part.type === "toolCall",
	)?.runtimeItemKey;
const ofRole = (entries: readonly Entry[], role: string) =>
	entries.find((entry) => entry.type === "message" && entry.message?.role === role);

it("RULING-126 (3) #5374 live, snapshot and persisted keys are one key, and a reload reuses it", async () => {
	vi.stubEnv(FLAG, "1");
	const cuts: { readonly lane: SessionAcceptanceLane; readonly root: FrozenAcceptedRoot }[] = [];
	const laneAccept = SessionAcceptanceLane.prototype.accept;
	vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
		this: SessionAcceptanceLane,
		...args: Parameters<SessionAcceptanceLane["accept"]>
	) {
		const ref = laneAccept.apply(this, args);
		if (ref && "type" in args[0] && args[0].type === "tool_execution_start")
			cuts.push({ lane: this, root: this.freeze() });
		return ref;
	});
	await using host = await statusHost();
	await writeFile(join(host.cwd, "note.txt"), "note body\n");
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const legacy = host.client("legacy");
	const routing = String(dataOf(await legacy.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	admissions.mockRestore();
	const session = entry?.runtime?.session ?? expect.unreachable("no in-process session");
	const compact = host.client("compact");
	host.writer.setConnectionCapabilities("compact", ["compact_events"]);
	host.writer.attachConnectionToSession("compact", routing);
	host.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }, { id: "call-1" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("read it"),
	]);
	const done = legacy.waitFor(
		(record) => record.type === "agent_idle" && record.sessionId === routing,
		EVENT_SAFETY_MS,
	);
	dataOf(await legacy.request({ type: "prompt", sessionId: routing, message: "read" }));
	await done;
	await host.writer.flush();

	const live = compact.inbox.find((record: WireRecord) => record.type === "tool_execution_start")?.runtimeItemKey;
	expect(live).toMatch(/^blk:[0-9a-f-]{36}:0$/);
	const [cut] = cuts;
	if (!cut) throw new Error("no execution cut");
	const snapshot = await cut.lane.readCurrentCalls(cut.root);
	cut.lane.release(cut.root);
	expect(snapshot.calls.map((call) => call.runtimeItemKey)).toEqual([live]);
	const file = session.sessionManager.getSessionFile() ?? expect.unreachable("no session file");
	const persisted = readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Entry);
	expect(keyOfPart(ofRole(persisted, "assistant"))).toBe(live);
	expect(ofRole(persisted, "toolResult")?.runtimeItemKey).toBe(live);

	const reloaded = SessionManager.open(file, dirname(file));
	const assistantId = (ofRole(persisted, "assistant") as { id?: string } | undefined)?.id ?? "";
	expect(reloaded.getToolCallKey(assistantId, 0)).toBe(live);
	vi.restoreAllMocks();
	const lane = new SessionAcceptanceLane();
	try {
		lane.bootstrap({ transcript: reloaded.beginTranscriptJournal() });
		const root = lane.freeze();
		const read = await readTranscriptRoot(root.transcript);
		lane.release(root);
		if (!read.ok) throw new Error(`transcript read failed: ${read.error}`);
		const entries = read.entries as readonly FileEntry[] as readonly Entry[];
		expect(keyOfPart(ofRole(entries, "assistant"))).toBe(live);
		expect(ofRole(entries, "toolResult")?.runtimeItemKey).toBe(live);
	} finally {
		lane.retire("close");
	}
}, 600_000);
