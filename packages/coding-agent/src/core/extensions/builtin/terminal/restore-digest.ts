/**
 * The ONE restore digest a generation sends after a restart: a single sentence naming every
 * monitor and background session, structured details for the TUI renderer, and a pending slot
 * so a digest decided before a model is bound is delivered later instead of dropped.
 */

import { noticeMessageRenderer } from "../../notice/index.ts";
import type { NoticeLine } from "../../notice/spec.ts";
import type { ExtensionAPI, MessageRenderer } from "../../types.ts";
import { formatElapsedSeconds } from "./monitor-status.ts";
import type { BackgroundRestoreResult, MonitorRestoreResult, RestoreDigest } from "./restore.ts";

export const RESTORE_DIGEST_CUSTOM_TYPE = "senpi-terminal:restore-digest";
const PREFIX = "Terminal state after restart";
const BUCKETS = ["restored", "muted", "lost", "completed", "attachedElsewhere", "expired"] as const;

export type RestoreDigestOutcome = "decided" | "deferred" | "corrupt";

export interface RestoreDigestDetails {
	readonly generation: number;
	readonly outcome: RestoreDigestOutcome;
	readonly downtimeMs: number;
	readonly downtimeIsUpperBound: true;
	readonly holder?: { readonly pid: number };
	readonly actionable: boolean;
	readonly monitors: readonly MonitorRestoreResult[];
	readonly backgroundSessions: readonly BackgroundRestoreResult[];
}

export interface RestoreDigestMessage {
	readonly customType: typeof RESTORE_DIGEST_CUSTOM_TYPE;
	readonly content: string;
	readonly display: true;
	readonly details: RestoreDigestDetails;
}

/** The slice of `ExtensionContext` delivery needs; `ExtensionContext` satisfies it. */
export interface RestoreDigestContext {
	readonly model: unknown;
	readonly ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface DigestSlot {
	set(message: RestoreDigestMessage): void;
	pending(): RestoreDigestMessage | undefined;
	/** Deliver the pending message; `deliver` returning false keeps it pending for a later flush. */
	flush(deliver: (message: RestoreDigestMessage) => boolean): boolean;
}

/** Wake the agent only when something needs a decision: a lost watch, an orphan, a live background job. */
export function isActionable(digest: Pick<RestoreDigest, "results" | "backgroundSessions">): boolean {
	return (
		digest.results.some((result) => result.outcome === "lost" || result.orphan !== undefined) ||
		digest.backgroundSessions.some((session) => session.outcome === "running")
	);
}

const label = (result: MonitorRestoreResult) => `${result.monitorId} "${result.description}"`;
const outcomeName = (outcome: string) => outcome.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
const downtimeNote = (ms: number) => (ms > 0 ? ` (offline up to ${formatElapsedSeconds(ms / 1000)})` : "");

function orphanNote(orphan: NonNullable<MonitorRestoreResult["orphan"]>): string {
	return `orphan pid ${orphan.pid} ${orphan.action === "killed" ? "killed" : "left running"}`;
}

function sentenceEntry(result: MonitorRestoreResult): string {
	const revived = result.outcome === "restored" || result.outcome === "muted";
	const fallback = revived ? (result.kind === "file" ? "rechecked" : "respawned") : undefined;
	const notes = [result.reason ?? fallback, result.orphan && orphanNote(result.orphan)].filter((note) => note);
	return notes.length > 0 ? `${label(result)} (${notes.join(", ")})` : label(result);
}

function backgroundEntry(session: BackgroundRestoreResult): string {
	if (session.outcome === "exited") return `${session.id} exited`;
	const pid = session.pid === undefined ? "" : `pid ${session.pid}, `;
	return `${session.id} "${session.command}" still running (${pid}output not captured)`;
}

function decidedSentence(digest: RestoreDigest): string {
	const clauses: string[] = [];
	for (const outcome of BUCKETS) {
		const entries = digest.results.filter((result) => result.outcome === outcome).map(sentenceEntry);
		if (entries.length > 0) clauses.push(`${outcomeName(outcome)} ${entries.length} - ${entries.join(", ")}`);
	}
	if (digest.backgroundSessions.length > 0) {
		clauses.push(`background: ${digest.backgroundSessions.map(backgroundEntry).join(", ")}`);
	}
	return `${PREFIX}${downtimeNote(digest.downtimeMs)}: ${clauses.join("; ") || "nothing to restore"}.`;
}

export function buildRestoreDigest(
	digest: RestoreDigest,
	meta: { readonly generation: number; readonly outcome: RestoreDigestOutcome; readonly holderPid?: number },
): RestoreDigestMessage {
	const outcome = meta.outcome === "decided" && digest.storeError ? "corrupt" : meta.outcome;
	const holder = meta.holderPid === undefined ? undefined : `pid ${meta.holderPid}`;
	const content =
		outcome === "deferred"
			? holder === undefined
				? `${PREFIX}: waiting for the session lease; monitors come back here once it is acquired.`
				: `${PREFIX}: monitors held by ${holder}; they come back here when that process exits.`
			: outcome === "corrupt"
				? `${PREFIX}: the saved monitor state was unreadable, nothing was restored.`
				: decidedSentence(digest);
	return {
		customType: RESTORE_DIGEST_CUSTOM_TYPE,
		content,
		display: true,
		details: {
			generation: meta.generation,
			outcome,
			downtimeMs: digest.downtimeMs,
			downtimeIsUpperBound: true,
			...(meta.holderPid === undefined ? {} : { holder: { pid: meta.holderPid } }),
			actionable: isActionable(digest),
			monitors: digest.results,
			backgroundSessions: digest.backgroundSessions,
		},
	};
}

export function createDigestSlot(): DigestSlot {
	let pendingMessage: RestoreDigestMessage | undefined;
	// Exactly one decided digest per generation: once one is delivered, later ones are ignored,
	// and a deferred note never displaces a decided digest still waiting for a model.
	let decidedDelivered = false;
	const isDecided = (message: RestoreDigestMessage) => message.details.outcome !== "deferred";
	return {
		set(message) {
			if (decidedDelivered) return;
			if (!isDecided(message) && pendingMessage !== undefined && isDecided(pendingMessage)) return;
			pendingMessage = message;
		},
		pending: () => pendingMessage,
		flush(deliver) {
			const message = pendingMessage;
			if (message === undefined || !deliver(message)) return false;
			pendingMessage = undefined;
			if (isDecided(message)) decidedDelivered = true;
			return true;
		},
	};
}

/** Returns false (message stays pending) while no model is bound: a turn without one cannot run. */
export function deliverRestoreDigest(
	pi: Pick<ExtensionAPI, "sendMessage">,
	ctx: RestoreDigestContext | undefined,
	message: RestoreDigestMessage,
): boolean {
	if (ctx?.model === undefined) return false;
	ctx.ui?.notify(message.content, "info");
	const actionable = message.details.actionable;
	pi.sendMessage(message, { triggerTurn: actionable, deliverAs: actionable ? "followUp" : "nextTurn" });
	return true;
}

function monitorLine(result: MonitorRestoreResult): NoticeLine {
	const reason = result.reason === undefined ? "" : `: ${result.reason}`;
	const orphan = result.orphan === undefined ? "" : ` (${orphanNote(result.orphan)})`;
	const tone = result.outcome === "lost" || result.orphan !== undefined ? "warning" : "dim";
	return { text: `${label(result)} ${outcomeName(result.outcome)}${reason}${orphan}`, tone };
}

const renderRestoreDigest: MessageRenderer<RestoreDigestDetails> = noticeMessageRenderer((message) => {
	const details = message.details;
	if (details === undefined) return undefined;
	const sessions = details.backgroundSessions;
	const counts = `${details.monitors.length} monitors · ${sessions.length} background sessions`;
	const content = typeof message.content === "string" ? message.content : "";
	return {
		title: `${PREFIX}${downtimeNote(details.downtimeMs)}`,
		tone: details.actionable ? "warning" : "accent",
		why: details.outcome === "decided" ? counts : content.slice(PREFIX.length + 2),
		extra: [
			...details.monitors.map(monitorLine),
			...sessions.map((session): NoticeLine => ({ text: backgroundEntry(session), tone: "dim" })),
		],
	};
});

export function registerRestoreDigestRenderer(pi: {
	registerMessageRenderer(customType: string, renderer: MessageRenderer<RestoreDigestDetails>): void;
}): void {
	pi.registerMessageRenderer(RESTORE_DIGEST_CUSTOM_TYPE, renderRestoreDigest);
}
