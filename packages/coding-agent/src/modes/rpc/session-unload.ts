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
 *   bash, an admitted delivery (named in `pending.deliveries`) or another request for the session. With
 *   `deliveries: "refuse"` a busy session (any `turn_active` blocker) that holds an admitted delivery not yet written
 *   is refused `work_pending` before anything is interrupted: its work would still read those deliveries, and the
 *   caller decides whether to drop them (senpi#7004). An idle session's unwritten deliveries are stranded, so they are
 *   handed back in either mode. `interrupt` aborts the run and bash
 *   and waits (bounded) before the final check; a delivery the aborted run left queued is handed back
 *   unwritten (`dropped.deliveries`), so an interrupted run never pins its session (oh-my-openagent#14169). A run whose only work is waiting on a dialog nobody
 *   answered (a permission prompt) is no refusal: the unload aborts it, which cancels the dialog, as if
 *   `interrupt` were set (senpi#6683). A run with a tool body executing is not parked, even when a dialog
 *   is open: the body may be doing real work beside the dialog.
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
import { sessionDialogRequests } from "./session-extension-ui-requests.ts";
import type { RpcSessionEntry } from "./session-registry.ts";
import {
	drainFacts,
	drainUntilQuiet,
	fenceForClose,
	type GracefulDrain,
	gracefulWaitMs,
	recordGracefulClose,
	reopenAfterDrain,
} from "./session-graceful-close.ts";
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
	/** The ids of the sessions open on this host that name this one as their parent or root. */
	openChildSessions(durableSessionId: string): readonly string[];
	/** The park teardown, sealed `session_parked { reason: "unloaded" }`. `false` when another close owns it. */
	tearDown(sessionId: string, sessionPath: string): Promise<boolean>;
}

interface Refusal {
	readonly reason: UnloadRefusalReason;
	readonly detail: string;
	readonly action?: string;
	/** The run only waits on an unanswered dialog: ending it stops no work, so no `interrupt` is needed. */
	readonly parked?: true;
	/** `work_pending` caused by admitted deliveries not yet written: their ids. */
	readonly deliveries?: readonly string[];
}

const ACTIONS = {
	extension_work: "let the named work finish, or unload with force: true (it is stopped, not resumed on reopen)",
	turn_active: "wait for the turn to end, or unload with interrupt: true to stop it first",
	work_pending: "wait for the work to finish, or unload with interrupt: true",
	work_pending_refused_deliveries:
		"the session's work would still read these deliveries: wait for it, or unload with interrupt: true and without deliveries to hand them back to their senders",
	children_live: 'wait for the child tasks, or unload with children: "detach" to leave them running',
	attached: "ask the other clients to detach, or unload with force: true (they receive session_parked)",
	graceful_expired:
		"the session is still open and admitting again: retry with a longer waitMs, or unload with interrupt: true to stop the turn",
} as const;

export async function unloadSession(port: SessionUnloadPort, command: UnloadSessionCommand): Promise<RpcResponse> {
	if (port.draining())
		return answer(
			command,
			refused({ reason: "host_draining", detail: "this host is draining and parks every session itself" }),
		);
	if (command.graceful === true && command.interrupt === true)
		return answer(
			command,
			refused({
				reason: "unsupported",
				detail: "graceful and interrupt exclude each other",
				action: "send one of them",
			}),
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
				// A replayed refusal answers the same reason, detail and action as the first one, and either answer names
				// the deliveries the first one handed back.
				...refusalFields(begun.replay.outcome),
				...(begun.replay.pending === undefined ? {} : { pending: begun.replay.pending }),
				...(begun.replay.dropped === undefined ? {} : { dropped: begun.replay.dropped }),
				...(begun.replay.detached === undefined ? {} : { detached: begun.replay.detached }),
				...effectAnswer(begun.replay, command.sessionId, true),
			});
	}
	const blocked = blockers(port, command, first.session, first.durableSessionId);
	if (command.graceful === true) return closeGracefully(port, command, first, blocked);
	// senpi#7004: a busy session's unread deliveries are what its work would still read. With `deliveries: "refuse"` they
	// decide the answer before anything else, with or without `interrupt`: the caller learns their ids, nothing stops.
	const unread = blocked.find((refusal) => refusal.deliveries !== undefined);
	if (
		command.deliveries === "refuse" &&
		unread !== undefined &&
		blocked.some((refusal) => refusal.reason === "turn_active")
	)
		return fail(command, first.session, { ...unread, action: ACTIONS.work_pending_refused_deliveries });
	// Never stop work for an unload that would still be refused: only interruptible blockers are interrupted.
	const standing = blocked.find(
		(refusal) => !interruptible(refusal) || (command.interrupt !== true && refusal.parked !== true),
	);
	if (standing !== undefined) return fail(command, first.session, standing);
	const handedBack = blocked.length > 0 ? await abortAndSettle(port, command.sessionId, first.session) : [];
	return claimAndUnload(port, command, handedBack);
}

/**
 * `graceful` (oh-my-openagent#14313): the turn and the work an interrupt would stop end on their own, bounded by
 * `waitMs`, behind the fence `fenceForClose` raises; published extension work is stopped cleanly by the teardown. A
 * drain that outlives the bound is refused `turn_active` with `timed_out`, and the session stays open and admitting.
 */
async function closeGracefully(
	port: SessionUnloadPort,
	command: UnloadSessionCommand,
	first: { session: AgentSession; durableSessionId: string },
	blocked: readonly Refusal[],
): Promise<RpcResponse> {
	const standing = blocked.find((refusal) => !interruptible(refusal));
	if (standing !== undefined) return fail(command, first.session, standing);
	const drain = fenceForClose(first.session);
	const busy = () =>
		blockers(port, command, first.session, first.durableSessionId)
			.filter(interruptible)
			.map((refusal) => refusal.detail);
	const settling = () => [port.otherRequestsSettled(command.sessionId), ...port.pendingPrompts(command.sessionId)];
	if (await drainUntilQuiet(first.session, { busy, settling }, gracefulWaitMs(command.waitMs)))
		return claimAndUnload(port, command, drain.dropped.deliveries, drain);
	reopenAfterDrain(first.session);
	const facts = drainFacts(first.session, drain);
	const expired: Refusal = {
		reason: "turn_active",
		detail: `still working after ${facts.waited_ms} ms: ${busy().join(", ")}`,
		action: ACTIONS.graceful_expired,
	};
	return fail(command, first.session, expired, droppedOf(drain.dropped.deliveries, drain), {
		timed_out: true,
		open: true,
		admission: "reopened",
		...facts,
	});
}

function droppedOf(
	handedBack: readonly string[],
	drain: GracefulDrain | undefined,
): { readonly dropped?: { deliveries: string[]; user_messages?: string[] } } {
	if (drain !== undefined)
		return { dropped: { deliveries: [...handedBack], user_messages: [...drain.dropped.user_messages] } };
	return handedBack.length === 0 ? {} : { dropped: { deliveries: [...handedBack] } };
}

/** The final check and the unload, without an await between them and the close claim. */
async function claimAndUnload(
	port: SessionUnloadPort,
	command: UnloadSessionCommand,
	handedBack: readonly string[],
	drain?: GracefulDrain,
): Promise<RpcResponse> {
	// Deliveries the interrupt handed back are gone from this runtime whatever the answer: every answer names them.
	const dropped = droppedOf(handedBack, drain);
	const ready = loaded(port, command.sessionId);
	if ("reason" in ready) return answer(command, { ...refused(ready), ...dropped });
	const stillBlocked = blockers(port, command, ready.session, ready.durableSessionId);
	if (stillBlocked.length > 0) {
		if (drain !== undefined) reopenAfterDrain(ready.session);
		return fail(command, ready.session, stillBlocked[0] as Refusal, dropped);
	}
	// Read in the step that claims the close, so the answer names exactly the children this unload left running.
	const detached = command.children === "detach" ? [...port.openChildSessions(ready.durableSessionId)] : [];
	if (command.clearQueue === true) {
		ClientAdmissions.clearQueuedFor(ready.session);
		ready.session.clearQueue();
	}
	const closed = drain === undefined ? undefined : recordGracefulClose(ready.session, drain);
	const effect =
		command.effectId === undefined
			? undefined
			: EffectLedger.forSession(ready.session).transition(command.effectId, "done", {
					disposition: "unloaded",
					...dropped,
					detached,
				});
	if (!(await port.tearDown(command.sessionId, ready.sessionPath))) {
		return answer(command, {
			outcome: "refused",
			reason: "session_closing",
			detail: "another close of this session finished first",
			...dropped,
		});
	}
	return answer(command, {
		outcome: "unloaded",
		sessionPath: ready.sessionPath,
		...dropped,
		detached,
		...(closed === undefined
			? {}
			: { graceful: { turn: closed.turn, waited_ms: closed.waited_ms, stopped: closed.stopped } }),
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
	// The run's own `prompt` call stays pending while it streams, so `pendingPrompts` does not count against a parked run.
	// A tool body that is executing is real work, even when a dialog is open beside it: a dialog cannot be told apart
	// from its opener (an MCP elicitation arrives on the server's channel), so any executing body rules out parked.
	const parked =
		activity.isStreaming &&
		!activity.isCompacting &&
		!activity.hasSessionWork &&
		session.toolDispatcher.executing === 0 &&
		(sessionDialogRequests.get(session)?.snapshot().length ?? 0) > 0;
	if (parked)
		found.push({
			reason: "turn_active",
			detail: "an agent run waiting on an unanswered prompt",
			action: ACTIONS.turn_active,
			parked: true,
		});
	else if (running.length > 0)
		found.push({ reason: "turn_active", detail: running.join(", "), action: ACTIONS.turn_active });
	const unwritten = session.externalAdmission.list().pending;
	const pending = [
		activity.isBashRunning && "a bash command",
		unwritten.length > 0 && "an admitted delivery not yet written",
		port.otherRequests(command.sessionId) > 0 && "another request for this session",
	].filter((label): label is string => typeof label === "string");
	if (pending.length > 0)
		found.push({
			reason: "work_pending",
			detail: pending.join(", "),
			action: ACTIONS.work_pending,
			...(unwritten.length === 0 ? {} : { deliveries: [...unwritten] }),
		});
	const sources = session.activeWakeSources;
	const childSources = sources.filter((source) => CHILD_TASK_SOURCE.test(source));
	const otherSources = sources.filter((source) => !CHILD_TASK_SOURCE.test(source));
	// A graceful close stops this work cleanly in its teardown: monitors and loops are not restored on a reopen.
	if (otherSources.length > 0 && command.force !== true && command.graceful !== true)
		found.push({
			reason: "extension_work",
			detail: `work published by ${otherSources.join(", ")}`,
			action: ACTIONS.extension_work,
		});
	const childSessions = port.openChildSessions(durableSessionId).length;
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
function fail(
	command: UnloadSessionCommand,
	session: AgentSession,
	refusal: Refusal,
	dropped: { readonly dropped?: { deliveries: string[]; user_messages?: string[] } } = {},
	expiry: Pick<RpcUnloadAnswer, "timed_out" | "open" | "admission" | "turn" | "waited_ms"> = {},
): RpcResponse {
	if (command.effectId === undefined) return answer(command, { ...refused(refusal), ...dropped, ...expiry });
	const status = EffectLedger.forSession(session).transition(command.effectId, "failed", {
		...dropped,
		...pendingOf(refusal),
		outcome: {
			kind: "refused",
			reason: refusal.reason,
			detail: refusal.detail,
			...(refusal.action === undefined ? {} : { action: refusal.action }),
		},
	});
	return answer(command, { ...refused(refusal), ...dropped, ...expiry, ...effectAnswer(status, command.sessionId) });
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

function pendingOf(refusal: Refusal): { pending?: { deliveries: string[] } } {
	return refusal.deliveries === undefined ? {} : { pending: { deliveries: [...refusal.deliveries] } };
}

function refused(refusal: Refusal): RpcUnloadAnswer {
	return {
		outcome: "refused",
		reason: refusal.reason,
		detail: refusal.detail,
		...(refusal.action === undefined ? {} : { action: refusal.action }),
		...pendingOf(refusal),
	};
}

function answer(command: UnloadSessionCommand, data: RpcUnloadAnswer): RpcResponse {
	return { id: command.id, type: "response", command: "unload_session", success: true, data };
}
