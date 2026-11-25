/**
 * A session file as a host left it when the run it was serving got cut (senpi#7020), and its reopen on the next host
 * as a session that was live there (`session_start` with `continued`). Shared by the restart-continuation regressions.
 */
import { type AssistantMessage, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { SessionStartEvent } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";
import { firstTurnSettled } from "./7020-live-park-support.ts";

const harnesses: Harness[] = [];

/** Disposes every harness this module made, newest first; call from `afterEach`. */
export function cleanupKilledMidRun(): void {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
}

/** What a host reopening a session that was live when its predecessor ended passes to `session_start`. */
export const continuedStart = { type: "session_start", reason: "resume", continued: true } as const;
export const asStart = (event: object): SessionStartEvent => event as SessionStartEvent;

export function answer(text: string): AssistantMessage {
	return fauxAssistantMessage(text);
}

/** The engine started the run: a monitor event's wake, recorded as an engine turn start. */
export const engineStarted = (saved: SessionManager): void => {
	saved.appendCustomEntry("engine-turn-start", { customType: "senpi-monitor:event" });
	saved.appendCustomMessageEntry("senpi-monitor:event", "build finished", false, {});
};

/** A session file as a SIGKILL left it: the opening lifecycle record says `runActive`, then `run` wrote its start. */
export async function killedMidRun(
	run: (saved: SessionManager) => void,
	options: { cutTool?: boolean } = {},
): Promise<{ base: Harness; file: string }> {
	const base = await createHarness({ persistSession: true });
	harnesses.push(base);
	const saved = base.sessionManager;
	saved.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
	saved.appendMessage(answer("Previous answer"));
	run(saved);
	saved.appendCustomEntry("session-lifecycle", {
		sessionId: saved.getSessionId(),
		state: "running",
		seq: 2,
		epoch: 1,
		epochOrigin: "automatic",
		humanInputRevision: 1,
		selfSettleEligible: true,
		runPaused: false,
		since: "2026-11-19T02:40:53.619Z",
		role: "root",
		rootSessionId: saved.getSessionId(),
		persisted: true,
		runActive: true,
		epochSealed: false,
		runId: "killed-run",
	});
	if (options.cutTool !== false)
		saved.appendMessage({
			...answer(""),
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "make deploy" } }],
			stopReason: "toolUse",
		});
	const file = saved.getSessionFile();
	if (!file) throw new Error("the killed session has no file");
	return { base, file };
}

/** The next host's reopen of `file` as a session that was live on its predecessor; `turn` settles on its first turn. */
export async function reopenContinued(base: Harness, file: string): Promise<{ h: Harness; turn: Promise<void> }> {
	const h = await createHarness({
		siblingOf: base,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: asStart(continuedStart),
	});
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage([fauxText("continued")])]);
	const turn = firstTurnSettled(h.session);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	return { h, turn };
}
