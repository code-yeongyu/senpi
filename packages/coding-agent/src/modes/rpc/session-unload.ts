/**
 * `unload_session`: free a session this host keeps loaded, keeping its transcript for a later
 * `open_session { sessionPath }` (senpi#3225).
 *
 * An unload is the idle sweep's park on request: the same teardown, sealed as `session_parked
 * { reason: "unloaded" }`. Queued input stays in the admission ledger, which restores it on the
 * reopen (id-less input too, senpi#1971), unless `clearQueue`. Unlike `release_session` the caller is
 * expected to be attached, and nothing hands the file to another runtime.
 *
 * Refusals change nothing and answer `outcome: "refused"` with `reason`, `detail` and `action`:
 * - `turn_active` / `work_pending`: an agent run, a prompt in preflight, compaction, barrier-held work,
 *   bash, an admitted delivery or another request for the session. `interrupt` aborts the run and bash
 *   and waits (bounded) before the final check.
 * - `extension_work`: a published wake source other than child tasks (background terminal jobs, monitors,
 *   detached eval cells, a pending question). The teardown stops that work and most of it does not come
 *   back on reopen, so only `force` unloads past it; the refusal names the sources.
 * - `children_live`: the session started child tasks that are still working (a `senpi-task` wake source)
 *   or worker sessions here name it as their parent or root. `children: "detach"` leaves them running.
 * - `attached`: other clients hold the session. `force` unloads anyway; they receive the park.
 * The last check and the close claim run in one synchronous step, as in `release_session`.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { beginEffect, effectAnswer, isEffectBegin } from "./effect-commands.ts";
import { EffectLedger } from "./effect-ledger.ts";
import type { EffectActor } from "./effect-record.ts";
import type { RpcCommand, RpcResponse, RpcUnloadAnswer, UnloadRefusalReason } from "./rpc-types.ts";
import type { RpcSessionEntry } from "./session-registry.ts";
import { abortAndSettle, type ReleaseSettlePort } from "./session-release-interrupt.ts";

export type UnloadSessionCommand = Extract<RpcCommand, { type: "unload_session" }>;

/** Wake sources whose live work is child tasks this session started. */
const CHILD_TASK_SOURCE = /^senpi-task/;

export interface SessionUnloadPort extends ReleaseSettlePort {
	readonly draining: () => boolean;
	readonly by: EffectActor;
	lookup(sessionId: string): RpcSessionEntry;
	code(cause: unknown): string;
	/** Requests for the session in flight on any connection, the unload itself not counted. */
	otherRequests(sessionId: string): number;
	/** Attachments held by connections other than the caller's. */
	otherAttachments(sessionId: string): number;
	/** Open worker sessions on this host whose context names `durableSessionId` as parent or root. */
	openChildSessions(durableSessionId: string): number;
	/** The park teardown, sealed `session_parked { reason: "unloaded" }`. `false` when another close owns it. */
	tearDown(sessionId: string, sessionPath: string): Promise<boolean>;
}

interface Refusal {
	readonly reason: UnloadRefusalReason;
	readonly detail: string;
	readonly action?: string;
}

const ACTIONS = {
	extension_work: "let the named work finish, or unload with force: true (it is stopped, not resumed on reopen)",
	turn_active: "wait for the turn to end, or unload with interrupt: true to stop it first",
	work_pending: "wait for the work to finish, or unload with interrupt: true",
	children_live: 'wait for the child tasks, or unload with children: "detach" to leave them running',
	attached: "ask the other clients to detach, or unload with force: true (they receive session_parked)",
} as const;

export async function unloadSession(port: SessionUnloadPort, command: UnloadSessionCommand): Promise<RpcResponse> {
	if (port.draining())
		return answer(
			command,
			refused({ reason: "host_draining", detail: "this host is draining and parks every session itself" }),
		);
	const first = loaded(port, command.sessionId);
	if ("reason" in first) return answer(command, refused(first));
	const { effectId } = command;
	if (effectId !== undefined) {
		const begun = await beginEffect({ session: first.session, by: port.by, sessionId: command.sessionId }, "unload", {
			...command,
			effectId,
		});
		if (!isEffectBegin(begun)) return begun;
		if ("replay" in begun)
			return answer(command, {
				outcome: begun.replay.state === "failed" ? "refused" : "unloaded",
				// A replayed refusal answers the same reason, detail and action as the first one.
				...refusalFields(begun.replay.outcome),
				...effectAnswer(begun.replay, command.sessionId, true),
			});
	}
	const blocked = blockers(port, command, first.session, first.durableSessionId);
	// Never stop work for an unload that would still be refused: only interruptible blockers are interrupted.
	const standing = blocked.find((refusal) => !interruptible(refusal) || command.interrupt !== true);
	if (standing !== undefined) return fail(command, first.session, standing);
	if (blocked.length > 0) await abortAndSettle(port, command.sessionId, first.session);
	return claimAndUnload(port, command);
}

/** The final check and the unload, without an await between them and the close claim. */
async function claimAndUnload(port: SessionUnloadPort, command: UnloadSessionCommand): Promise<RpcResponse> {
	const ready = loaded(port, command.sessionId);
	if ("reason" in ready) return answer(command, refused(ready));
	const stillBlocked = blockers(port, command, ready.session, ready.durableSessionId);
	if (stillBlocked.length > 0) return fail(command, ready.session, stillBlocked[0] as Refusal);
	if (command.clearQueue === true) {
		ClientAdmissions.clearQueuedFor(ready.session);
		ready.session.clearQueue();
	}
	const effect =
		command.effectId === undefined
			? undefined
			: EffectLedger.forSession(ready.session).transition(command.effectId, "done", { disposition: "unloaded" });
	if (!(await port.tearDown(command.sessionId, ready.sessionPath))) {
		return answer(command, {
			outcome: "refused",
			reason: "session_closing",
			detail: "another close of this session finished first",
		});
	}
	return answer(command, {
		outcome: "unloaded",
		sessionPath: ready.sessionPath,
		...(effect === undefined ? {} : effectAnswer(effect, command.sessionId)),
	});
}

function interruptible(refusal: Refusal): boolean {
	return refusal.reason === "turn_active" || refusal.reason === "work_pending";
}

function blockers(
	port: SessionUnloadPort,
	command: UnloadSessionCommand,
	session: AgentSession,
	durableSessionId: string,
): Refusal[] {
	const found: Refusal[] = [];
	const activity = session.activitySnapshot;
	const running = [
		activity.isStreaming && "an agent run",
		port.pendingPrompts(command.sessionId).length > 0 && "a prompt about to start",
		activity.isCompacting && "compaction",
		activity.hasSessionWork && "session work",
	].filter((label): label is string => typeof label === "string");
	if (running.length > 0)
		found.push({ reason: "turn_active", detail: running.join(", "), action: ACTIONS.turn_active });
	const pending = [
		activity.isBashRunning && "a bash command",
		session.externalAdmission.list().pending.length > 0 && "an admitted delivery not yet written",
		port.otherRequests(command.sessionId) > 0 && "another request for this session",
	].filter((label): label is string => typeof label === "string");
	if (pending.length > 0)
		found.push({ reason: "work_pending", detail: pending.join(", "), action: ACTIONS.work_pending });
	const sources = session.activeWakeSources;
	const childSources = sources.filter((source) => CHILD_TASK_SOURCE.test(source));
	const otherSources = sources.filter((source) => !CHILD_TASK_SOURCE.test(source));
	if (otherSources.length > 0 && command.force !== true)
		found.push({
			reason: "extension_work",
			detail: `work published by ${otherSources.join(", ")}`,
			action: ACTIONS.extension_work,
		});
	const childSessions = port.openChildSessions(durableSessionId);
	if (command.children !== "detach" && (childSources.length > 0 || childSessions > 0)) {
		const what =
			childSessions > 0 ? `${childSessions} child session(s) open on this host` : "child tasks still working";
		found.push({ reason: "children_live", detail: what, action: ACTIONS.children_live });
	}
	const others = port.otherAttachments(command.sessionId);
	if (others > 0 && command.force !== true)
		found.push({ reason: "attached", detail: `${others} other client(s) attached`, action: ACTIONS.attached });
	return found;
}

function loaded(
	port: SessionUnloadPort,
	sessionId: string,
): { session: AgentSession; sessionPath: string; durableSessionId: string } | Refusal {
	let entry: RpcSessionEntry;
	try {
		entry = port.lookup(sessionId);
	} catch (cause) {
		return { reason: "unsupported", detail: port.code(cause) };
	}
	if (entry.state !== "open") return { reason: "session_closing", detail: "the session is already closing" };
	const session = entry.runtime?.session;
	if (session === undefined) return { reason: "unsupported", detail: "a worker isolate owns this session's runtime" };
	const sessionPath = entry.sessionPath ?? session.sessionFile;
	if (sessionPath === undefined)
		return {
			reason: "unsupported",
			detail: "the session has no file to reopen it by",
			action: "send a prompt first so the session is written, or close it instead",
		};
	return { session, sessionPath, durableSessionId: session.sessionManager.getSessionId() };
}

/** A refusal after the effect began records it `failed`; the answer carries the receipt. */
function fail(command: UnloadSessionCommand, session: AgentSession, refusal: Refusal): RpcResponse {
	if (command.effectId === undefined) return answer(command, refused(refusal));
	const status = EffectLedger.forSession(session).transition(command.effectId, "failed", {
		outcome: {
			kind: "refused",
			reason: refusal.reason,
			detail: refusal.detail,
			...(refusal.action === undefined ? {} : { action: refusal.action }),
		},
	});
	return answer(command, { ...refused(refusal), ...effectAnswer(status, command.sessionId) });
}

function refusalFields(
	outcome: { reason?: string; detail?: string; action?: string } | undefined,
): Partial<RpcUnloadAnswer> {
	if (outcome?.reason === undefined) return {};
	return {
		reason: outcome.reason as UnloadRefusalReason,
		...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
		...(outcome.action === undefined ? {} : { action: outcome.action }),
	};
}

function refused(refusal: Refusal): RpcUnloadAnswer {
	return {
		outcome: "refused",
		reason: refusal.reason,
		detail: refusal.detail,
		...(refusal.action === undefined ? {} : { action: refusal.action }),
	};
}

function answer(command: UnloadSessionCommand, data: RpcUnloadAnswer): RpcResponse {
	return { id: command.id, type: "response", command: "unload_session", success: true, data };
}
