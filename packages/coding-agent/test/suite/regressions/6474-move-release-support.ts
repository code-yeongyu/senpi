import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../../src/modes/rpc/session-release.ts";
import { heldTurn, nextEvent, type startReleaseHost } from "../rpc-release-host-support.ts";

type ReleaseHost = Awaited<ReturnType<typeof startReleaseHost>>;

export const customTypes = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { customType?: string })
		.map((entry) => entry.customType)
		.filter((type) => type?.startsWith("session_"));

/** The pending-input journal lines `finish` wrote for `moveId`: one admit per re-queued message. */
export const requeuedLines = (file: string, moveId: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.includes(`"clientMessageId":"move:${moveId}:`));

/** A session mid-turn with one queued user message, ready for a `move` release with `interrupt`. */
export async function sessionWithQueuedInput(host: ReleaseHost, name: string, text: string) {
	host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
	const opened = await host.open(name);
	const started = nextEvent(opened.session, "agent_start");
	await host.send({ type: "prompt", id: "work", sessionId: opened.sessionId, message: "long work" });
	await started;
	await host.send({ type: "follow_up", id: "f", sessionId: opened.sessionId, message: text });
	return opened;
}

export const releaseForMove = (host: ReleaseHost, sessionId: string, moveId: string, id = "rel", interrupt = true) =>
	host.send({ type: "release_session", id, sessionId, reason: "move", moveId, target: "device-b", interrupt });

export const finishDeclined = (host: ReleaseHost, sessionPath: string, moveId: string, id = "fin") =>
	host.send({
		type: "move_session",
		id,
		op: "finish",
		sessionPath,
		moveId,
		answer: { state: "declined", reason: "cancelled" },
	});

/** A session with one queued user message, released for `moveId` with `interrupt`: the answer carries the message. */
export async function queuedMoveRelease(host: ReleaseHost, name: string, moveId: string, text = "USER QUEUED TEXT") {
	const { sessionId, sessionPath } = await sessionWithQueuedInput(host, name, text);
	const released = await releaseForMove(host, sessionId, moveId);
	expect(released).toMatchObject({ success: true });
	return { sessionId, sessionPath, released };
}

/** The session file refuses the `session_released` seal, so a release fails after everything before its seal ran. */
export function failSealWrite(session: AgentSession): { restore: () => void } {
	const manager = session.sessionManager;
	const persist = manager._persist.bind(manager);
	const spy = vi.spyOn(manager, "_persist").mockImplementation((entry) => {
		if (entry.type === "custom" && entry.customType === SESSION_RELEASED_ENTRY_TYPE) {
			throw Object.assign(new Error("EACCES: permission denied, open 'session.jsonl'"), { code: "EACCES" });
		}
		persist(entry);
	});
	return { restore: () => spy.mockRestore() };
}
