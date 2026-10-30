import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// senpi#4272 RULING-33 condition 2 (S03b-3b): the four cold flows come from the session manager's own committed
// transcript changes, in order after acceptance: a context edit replaces, a context edit with no replacement removes (context_edit_removal), a compaction
// removes everything before its first kept entry, and a leaf move removes what left the path and reinstalls what joined it.
it("RULING-33 cond. 2 real producers drive edit, context-edit removal, compaction removal and branch into compact state", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("flows");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	const manager = entry?.runtime?.session.sessionManager;
	if (!lane || !manager) throw new Error("no real lane");
	for (const [message, answer] of [
		["u-one", "a-one"],
		["u-two", "a-two"],
		["u-three", "a-three"],
	]) {
		host.faux.setResponses([fauxAssistantMessage(answer, { timestamp: 1 })]);
		const idle = (record: { type?: unknown }) => record.type === "agent_idle";
		const seen = client.inbox.filter(idle).length;
		const done = client.waitFor((record) => idle(record) && client.inbox.filter(idle).length > seen, 15_000);
		dataOf(await client.request({ type: "prompt", sessionId, message }));
		await done;
	}
	const find = (text: string): SessionEntry => {
		const found = manager.getBranch().find((each) => each.type === "message" && JSON.stringify(each).includes(text));
		if (!found) throw new Error(`no entry ${text}`);
		return found;
	};
	// Any record drains the manager's journal into the lane before it is accepted, as after every real change.
	const settle = async () => {
		dataOf(await client.request({ type: "get_state", sessionId }));
		await lane.idle();
		const root = lane.freeze();
		try {
			const { messages } = await lane.readCurrent(root);
			return messages.map((message) => JSON.stringify(message.message ?? message.blocks));
		} finally {
			lane.release(root);
		}
	};
	const has = (view: readonly string[], text: string) => view.some((message) => message.includes(text));
	const first = find("u-one");
	const before = await settle();
	for (const text of ["u-one", "a-one", "u-two", "a-two", "u-three", "a-three"])
		expect(has(before, text), text).toBe(true);

	manager.appendContextEdit(find("a-one").id, { content: "a-one edited" });
	const edited = await settle();
	expect(has(edited, "a-one edited")).toBe(true);
	expect(edited.filter((message) => message.includes("a-one"))).toHaveLength(1);

	manager.appendContextEdit(find("u-two").id, null);
	const deleted = await settle();
	expect(has(deleted, "u-two")).toBe(false);
	expect(has(deleted, "a-two")).toBe(true);

	manager.appendCompaction("summary", find("u-three").id, 0);
	const compacted = await settle();
	for (const text of ["u-one", "a-one", "a-two"]) expect(has(compacted, text), text).toBe(false);
	for (const text of ["u-three", "a-three"]) expect(has(compacted, text), text).toBe(true);

	manager.branch(first.id);
	const branched = await settle();
	expect(has(branched, "u-one"), "the message that joined the path is installed again").toBe(true);
	for (const text of ["u-three", "a-three"]) expect(has(branched, text), text).toBe(false);
}, 90_000);
