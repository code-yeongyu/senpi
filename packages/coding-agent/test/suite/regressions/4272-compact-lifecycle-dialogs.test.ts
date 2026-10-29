import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const lifecycle = (phase: string) => ({ type: "session_lifecycle", sessionId: "s", lifecycle: { phase } });
const question = { type: "extension_ui_request", method: "question", id: "q1", deadlineAtMs: 10, questions: [] };
const targeted = { type: "extension_ui_request", method: "select", id: "t1", title: "targeted secret", options: [] };

// senpi#4272 RULING-26 Q4, RULING-25 Q4 (S03b-3b): run state, the latest lifecycle and the open dialogs are frozen
// roots of the shared cut, each change at its own lane sequence; a targeted dialog keeps no body a late peer could see.
it("RULING-26 Q4 freezes run state, lifecycle and dialogs at one sequence; targeted dialogs keep no body", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-components-"));
	const lane = new SessionAcceptanceLane({ dir });
	try {
		lane.bootstrap({ transcript: SessionManager.inMemory(dir).beginTranscriptJournal() });
		for (const record of [lifecycle("one"), { type: "agent_start" }, question, targeted])
			lane.accept(record, undefined);
		const held = lane.freeze();
		const later = [
			{ type: "question_updated", id: "q1", deadlineAtMs: 20, remainingMs: 5 },
			{ type: "ui_request_settled", uiRequestId: "t1", disposition: "cancelled" },
			lifecycle("two"),
		];
		for (const record of later) lane.accept(record, undefined);
		const updated = lane.freeze();
		for (const record of [
			{ type: "question_resolved", id: "q1" },
			{ type: "agent_end", messages: [] },
		])
			lane.accept(record, undefined);
		const settled = lane.freeze();
		expect(updated.sequence - held.sequence).toBe(later.length);
		const heldView = await lane.readCurrentComponents(held);
		expect(heldView).toEqual({
			runState: "running",
			lifecycle: lifecycle("one"),
			dialogs: [
				{ id: "q1", audience: "broadcast", method: "question", deadlineAtMs: 10, request: question },
				{ id: "t1", audience: "targeted", method: "select" },
			],
			dialogCounts: { broadcast: 1, targeted: 1 },
		});
		expect(JSON.stringify(heldView)).not.toContain("targeted secret");
		expect(await lane.readCurrentComponents(updated)).toMatchObject({
			lifecycle: lifecycle("two"),
			dialogs: [{ id: "q1", deadlineAtMs: 20 }],
			dialogCounts: { broadcast: 1, targeted: 0 },
		});
		expect(await lane.readCurrentComponents(settled)).toEqual({
			runState: "idle",
			lifecycle: lifecycle("two"),
			dialogs: [],
			dialogCounts: { broadcast: 0, targeted: 0 },
		});
		expect(await lane.readCurrentComponents(held), "a held cut never moves").toEqual(heldView);
		for (const root of [held, updated, settled]) lane.release(root);
	} finally {
		lane.retire("close");
		await lane.idle();
		await rm(dir, { recursive: true, force: true });
	}
});

it("RULING-26 Q4 a real in-process session folds its own lifecycle and run state into the cut", async () => {
	// Compact acceptance and client delivery stamp their own observation of the same lifecycle.
	vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 29));
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("components");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	if (!lane) throw new Error("no real lane");
	host.faux.setResponses([fauxAssistantMessage("done", { timestamp: 1 })]);
	const done = client.waitFor((record) => record.type === "agent_idle", 15_000);
	dataOf(await client.request({ type: "prompt", sessionId, message: "go" }));
	await done;
	await host.writer.flush();
	const last = client.inbox.findLast((record) => record.type === "session_lifecycle");
	expect(last, "the session published its lifecycle").toBeDefined();
	const root = lane.freeze();
	try {
		const view = await lane.readCurrentComponents(root);
		expect(view.runState).toBe("idle");
		expect(view.lifecycle).toMatchObject({ type: "session_lifecycle", lifecycle: last?.lifecycle });
		expect(view.dialogs).toEqual([]);
	} finally {
		lane.release(root);
	}
}, 60_000);
