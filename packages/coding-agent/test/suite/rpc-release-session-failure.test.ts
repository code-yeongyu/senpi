/**
 * `release_session` when writing its `session_released` entry fails (EACCES, ENOSPC, a removed directory),
 * on a REAL in-process host: the release answers `release_failed` instead of leaving the caller waiting,
 * the session stays hosted with admission open, and no phantom entry is left in memory for a later
 * append to chain onto.
 */
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { heldTurn, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

const WRITE_FAILURE = "EACCES: permission denied, open 'session.jsonl'";

function failReleasedEntryWrite(session: AgentSession): { restore: () => void } {
	const manager = session.sessionManager;
	const persist = manager._persist.bind(manager);
	const spy = vi.spyOn(manager, "_persist").mockImplementation((entry) => {
		if (entry.type === "custom" && entry.customType === SESSION_RELEASED_ENTRY_TYPE) {
			throw Object.assign(new Error(WRITE_FAILURE), { code: "EACCES" });
		}
		persist(entry);
	});
	return { restore: () => spy.mockRestore() };
}

function unchainedEntries(sessionPath: string): string[] {
	const entries = SessionManager.open(sessionPath).getEntries();
	const ids = new Set(entries.map((entry) => entry.id));
	return entries.filter((entry) => entry.parentId !== null && !ids.has(entry.parentId)).map((entry) => entry.id);
}

describe("release_session when its entry cannot be written (real host)", () => {
	it("answers release_failed, keeps admission open and leaves no phantom entry", async () => {
		// Given: a quiet session whose file refuses the release entry.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("delivery reply")]);
		const { sessionId, sessionPath, session } = await host.open("write-fails");
		const failing = failReleasedEntryWrite(session);

		// When: it is released.
		const reply = await host.release(sessionId);
		failing.restore();

		// Then: a refusal naming the failure, and the session keeps working as hosted.
		expect(reply).toMatchObject({ success: false, error: "release_failed", errorData: { detail: WRITE_FAILURE } });
		const releasedInMemory = session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === SESSION_RELEASED_ENTRY_TYPE);
		expect(releasedInMemory).toEqual([]);
		const settled = nextEvent(session, "agent_settled");
		expect(await host.send({ type: "wake", id: "w", sessionId, delivery_ids: ["after-failure"] })).toMatchObject({
			success: true,
			data: { admitted: [{ delivery_id: "after-failure", kind: "started" }] },
		});
		await settled;
		expect(readFileSync(sessionPath, "utf8")).toContain("DELIVERY after-failure");
		expect(unchainedEntries(sessionPath)).toEqual([]);
		expect(readFileSync(sessionPath, "utf8")).not.toContain(SESSION_RELEASED_ENTRY_TYPE);
	});

	it("after an interrupt, still reports the queued text it took", async () => {
		// Given: a turn running with user text queued behind it, and a file that refuses the release entry.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("write-fails-interrupt");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		await host.send({ type: "follow_up", id: "f", sessionId, message: "USER FOLLOW TEXT" });
		const failing = failReleasedEntryWrite(session);

		// When: it is released with interrupt.
		const reply = await host.release(sessionId, { interrupt: true });
		failing.restore();

		// Then: the text comes back in the refusal and admission is open again.
		expect(reply).toMatchObject({
			success: false,
			error: "release_failed",
			errorData: {
				detail: WRITE_FAILURE,
				interrupted: true,
				dropped: { deliveries: [], user_messages: ["USER FOLLOW TEXT"] },
			},
		});
		expect(readFileSync(sessionPath, "utf8")).not.toContain("USER FOLLOW TEXT");
		expect(await host.send({ type: "wake", id: "w", sessionId, delivery_ids: ["after-failure"] })).toMatchObject({
			success: true,
			data: { admitted: [{ delivery_id: "after-failure" }] },
		});
		expect(gateway.outcomes.filter((outcome) => outcome.includes(":refused:"))).toEqual([]);
	});
});
