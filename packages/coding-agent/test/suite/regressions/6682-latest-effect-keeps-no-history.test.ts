import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { CLIENT_ADMISSION_ENTRY, type ClientAdmissionRecord } from "../../../src/modes/rpc/client-admission-record.ts";
import { latestSessionEffect } from "../../../src/modes/rpc/effect-ledger.ts";
import { RPC_EFFECT_ENTRY, type RpcEffectRecord } from "../../../src/modes/rpc/effect-record.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";

const LARGE_TEXT = "x".repeat(256 * 1024);

function effect(session: SessionManager, effectId: string, state: RpcEffectRecord["state"]): void {
	const record: RpcEffectRecord = {
		effectId,
		kind: "abort",
		state,
		by: { connectionId: "c1" },
		acceptedAt: "2026-11-23T00:00:00.000Z",
		updatedAt: "2026-11-23T00:00:00.000Z",
		durableSessionId: session.getSessionId(),
		fingerprint: `fp-${effectId}`,
	};
	session.appendCustomEntry(RPC_EFFECT_ENTRY, record);
}

function admission(session: SessionManager, clientMessageId: string): void {
	const record: ClientAdmissionRecord = {
		clientMessageId,
		durableSessionId: session.getSessionId(),
		fingerprint: `fp-${clientMessageId}`,
		disposition: "started",
		state: "running",
	};
	session.appendCustomEntry(CLIENT_ADMISSION_ENTRY, record);
}

function latest(sessionManager: SessionManager): { effectId: string; kind: string; state: string } | undefined {
	const status = latestSessionEffect({ sessionManager });
	return status === undefined ? undefined : { effectId: status.effectId, kind: status.kind, state: status.state };
}

// senpi#6682: the status stream's newest-effect read must not rebuild a released idle session's full history.
describe("latestSessionEffect on a released, trimmed session (senpi#6682)", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `latest-effect-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** An effect written before a compaction whose window leaves it on disk only, so the mirror is trimmed. */
	function compactedSessionWithEarlyEffect() {
		const session = SessionManager.create(dir, dir);
		session.appendModelChange("anthropic", "test");
		session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		effect(session, "early-abort", "done");
		session.appendMessage(assistantMsg(`early answer ${LARGE_TEXT}`));
		const firstKept = session.appendMessage(userMsg("kept request"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary of the early work", firstKept, 1000);
		session.appendMessage(userMsg("after compaction"));
		const file = session.getSessionFile();
		if (file === undefined) throw new Error("expected a persisted session file");
		return { session, file };
	}

	it("returns the newest effect without holding the history, live and after a reopen", () => {
		const { session, file } = compactedSessionWithEarlyEffect();
		session.dropMaterializedCaches();
		expect(session.holdsMaterializedHistory()).toBe(false);

		expect(latest(session)).toEqual({ effectId: "early-abort", kind: "abort", state: "done" });
		expect(session.holdsMaterializedHistory()).toBe(false);

		const reopened = SessionManager.open(file, dir);
		reopened.dropMaterializedCaches();
		expect(latest(reopened)).toEqual({ effectId: "early-abort", kind: "abort", state: "done" });
		expect(reopened.holdsMaterializedHistory()).toBe(false);
		// The mirror really is trimmed: a full-history read does hold the history.
		reopened.getEntries();
		expect(reopened.holdsMaterializedHistory()).toBe(true);
	});

	it("follows effects and admissions appended after a read, and the newest survives a later compaction and reopen", () => {
		const { session, file } = compactedSessionWithEarlyEffect();
		session.dropMaterializedCaches();
		expect(latest(session)?.effectId).toBe("early-abort");

		effect(session, "late-abort", "accepted");
		expect(latest(session)).toEqual({ effectId: "late-abort", kind: "abort", state: "accepted" });
		admission(session, "msg-1");
		expect(latest(session)).toEqual({ effectId: "msg-1", kind: "input", state: "applied" });
		effect(session, "late-abort", "done");
		expect(latest(session)).toEqual({ effectId: "late-abort", kind: "abort", state: "done" });
		session.appendCustomEntry(RPC_EFFECT_ENTRY, { effectId: "broken" });
		expect(latest(session)?.effectId).toBe("late-abort");

		const firstKept = session.appendMessage(userMsg(`second window ${LARGE_TEXT}`));
		session.appendCompaction("summary again", firstKept, 1000);
		session.appendMessage(userMsg("after the second compaction"));
		session.dropMaterializedCaches();
		expect(latest(session)).toEqual({ effectId: "late-abort", kind: "abort", state: "done" });
		expect(session.holdsMaterializedHistory()).toBe(false);

		const reopened = SessionManager.open(file, dir);
		reopened.dropMaterializedCaches();
		expect(latest(reopened)).toEqual({ effectId: "late-abort", kind: "abort", state: "done" });
		expect(reopened.holdsMaterializedHistory()).toBe(false);
	});

	it("answers undefined for a session with no receipt", () => {
		const session = SessionManager.inMemory(dir);
		session.appendMessage(userMsg("hello"));
		expect(latest(session)).toBeUndefined();
	});
});
