import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import type { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, type RawClient, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Host = Awaited<ReturnType<typeof statusHost>>;

function texts(messages: readonly unknown[]): string[] {
	return messages.map((message) => JSON.stringify(message));
}

const holds = (view: readonly string[], text: string) => view.some((each) => each.includes(JSON.stringify(text)));

type Said = { role: string; content: string | { type: string; text?: string }[] };

function said(each: string): string {
	const { role, content } = JSON.parse(each) as Said;
	return `${role}: ${typeof content === "string" ? content : content.map((part) => part.text ?? "").join("")}`;
}

function conversation(view: readonly string[]): string[] {
	return view
		.map(said)
		.filter((line) => line.startsWith("user: ") || line.startsWith("assistant: "))
		.map((line) => line.slice(line.indexOf(": ") + 2));
}

async function open(host: Host, name: string, sessionPath?: string) {
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client(name);
	const opened = dataOf(
		await client.request({ type: "open_session", cwd: host.cwd, ...(sessionPath && { sessionPath }) }),
	);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	admissions.mockRestore();
	if (!entry?.acceptance) throw new Error("no real lane");
	return { client, sessionId: String(opened.sessionId), lane: entry.acceptance };
}

function activePath(entries: readonly { id: string; parentId?: string | null }[], leafId: string | null) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: string[] = [];
	for (let id = leafId; id; id = byId.get(id)?.parentId ?? null) path.unshift(id);
	return path;
}

async function views(client: RawClient, sessionId: string, lane: SessionAcceptanceLane) {
	const shown = texts((dataOf(await client.request({ type: "get_messages", sessionId })).messages as unknown[]) ?? []);
	await lane.idle();
	const root = lane.freeze();
	try {
		const { messages } = await lane.readCurrent(root);
		const transcript = readTranscriptRoot(root.transcript);
		if (!transcript.ok) throw new Error(`transcript read failed: ${transcript.error}`);
		return {
			shown,
			compact: messages.map((message) => JSON.stringify(message.message ?? message.blocks)),
			entryIds: transcript.entries.map((entry) => entry.id),
			path: activePath(transcript.entries, root.transcript.leafId),
		};
	} finally {
		lane.release(root);
	}
}

// senpi#4272 RULING-48 (2): edit_user_message and edit_assistant_message append an edited copy compact state never
// installs (it has no recovery owner). After a crash and a reopen from the transcript, the edited copies are still what
// the session shows. Before the crash compact state holds only messages the session shows (no pre-edit original).
// After recovery the fresh host's compact state starts empty for its new epoch (nothing is reinstalled), so what the
// user sees comes from the transcript alone and compact state cannot hide or contradict any of it.
it("RULING-48 (2) edited user and assistant copies survive crash recovery from the transcript; compact state hides none", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using recovered = await statusHost();
	await using crashed = await statusHost();
	const live = await open(crashed, "before-crash");
	const turn = async (message: string, answer: string) => {
		crashed.faux.setResponses([fauxAssistantMessage(answer, { timestamp: 1 })]);
		const idle = (record: { type?: unknown }) => record.type === "agent_idle";
		const seen = live.client.inbox.filter(idle).length;
		const done = live.client.waitFor(
			(record) => idle(record) && live.client.inbox.filter(idle).length > seen,
			15_000,
		);
		dataOf(await live.client.request({ type: "prompt", sessionId: live.sessionId, message }));
		await done;
	};
	const entryOf = async (text: string): Promise<string> => {
		const entries = dataOf(await live.client.request({ type: "get_entries", sessionId: live.sessionId })).entries as {
			id: string;
			type: string;
		}[];
		const found = entries.findLast((each) => each.type === "message" && holds([JSON.stringify(each)], text));
		if (!found) throw new Error(`no entry ${text}`);
		return found.id;
	};
	const edit = async (type: "edit_user_message" | "edit_assistant_message", from: string, text: string) => {
		const result = dataOf(
			await live.client.request({ type, sessionId: live.sessionId, entryId: await entryOf(from), text }),
		);
		expect(result.outcome, type).toBe("edited");
		return String((result.entry as { id: string }).id);
	};

	await turn("u-one", "a-one");
	await turn("u-two", "a-two");
	const editedAssistant = await edit("edit_assistant_message", "a-one", "a-one edited");
	await turn("u-three", "a-three");
	const editedUser = await edit("edit_user_message", "u-three", "u-three edited");
	const shownBefore = ["u-one", "a-one edited", "u-three edited"];

	const before = await views(live.client, live.sessionId, live.lane);
	for (const text of shownBefore) expect(holds(before.shown, text), `shown before the crash: ${text}`).toBe(true);
	for (const text of ["a-one", "u-two", "a-two", "u-three", "a-three"])
		expect(holds(before.shown, text), `replaced or abandoned: ${text}`).toBe(false);
	expect(conversation(before.shown), "the conversation the session shows").toEqual(shownBefore);
	expect(before.compact.length, "compact state holds this epoch's owned messages").toBeGreaterThan(0);
	for (const message of before.compact)
		expect(before.shown.map(said), "every compact message is one the session shows").toContain(said(message));

	// The crash: the transcript bytes on disk at this instant, copied while the first host is still running, with no
	// close, flush or shutdown of its session. Recovery opens that copy in a second, fresh host.
	const file = String(dataOf(await live.client.request({ type: "get_state", sessionId: live.sessionId })).sessionFile);
	const copy = join(recovered.cwd, "recovered.jsonl");
	writeFileSync(copy, readFileSync(file));

	const reopened = await open(recovered, "after-recovery", copy);
	const after = await views(reopened.client, reopened.sessionId, reopened.lane);
	expect(conversation(after.shown), "the recovered conversation keeps both edited copies").toEqual(shownBefore);
	expect(after.shown, "the session shows exactly what it showed before the crash").toEqual(before.shown);
	for (const id of [editedAssistant, editedUser])
		expect(after.entryIds, "the edited copy is in the recovered transcript").toContain(id);
	expect(after.path, "both edited copies are on the recovered active path").toEqual(
		expect.arrayContaining([editedAssistant, editedUser]),
	);
	expect(after.path.indexOf(editedAssistant)).toBeLessThan(after.path.indexOf(editedUser));
	expect(after.path.slice(0, before.path.length), "recovery only extends the pre-crash path").toEqual(before.path);
	for (const text of ["a-one", "u-three"])
		expect(holds(before.compact, text), `no pre-edit original in compact state: ${text}`).toBe(false);
	expect(
		after.compact,
		"the recovered epoch's compact state starts empty: nothing reinstalled, nothing hidden",
	).toEqual([]);
}, 120_000);
