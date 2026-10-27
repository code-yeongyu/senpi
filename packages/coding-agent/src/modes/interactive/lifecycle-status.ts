import { sanitizeTerminalLabel } from "@earendil-works/pi-tui";
import type { SessionLifecycle } from "../../core/session-lifecycle-types.ts";

export const LIFECYCLE_STATUS_KEY = "session-lifecycle";

/** Coarse state and activity have different high-water marks. Only a bound snapshot can change owners. */
export class LifecycleStatus {
	private sessionId?: string;
	private owner?: string;
	private snapshot?: SessionLifecycle;
	private activitySeq = -1;
	private activityRevision = -1;

	owns(snapshot: SessionLifecycle): boolean {
		return snapshot.activityRevision === undefined || snapshot.activityRevision.instanceId === this.owner;
	}

	bind(sessionId: string, snapshot: SessionLifecycle): void {
		if (sessionId !== this.sessionId) {
			this.sessionId = sessionId;
			this.owner = undefined;
			this.snapshot = undefined;
			this.activitySeq = -1;
			this.activityRevision = -1;
		}
		const owner = snapshot.activityRevision?.instanceId;
		if (owner !== undefined && owner !== this.owner) {
			this.owner = owner;
			this.activitySeq = -1;
			this.activityRevision = -1;
			if (this.snapshot) this.snapshot = { ...this.snapshot, activity: undefined, activityRevision: undefined };
		}
		this.accept(snapshot);
	}

	accept(snapshot: SessionLifecycle): void {
		const previous = this.snapshot;
		if (previous && snapshot.seq < previous.seq) return;
		const newer = previous === undefined || snapshot.seq > previous.seq;
		const revision = snapshot.activityRevision;
		const acceptedActivity =
			revision !== undefined
				? revision.instanceId === this.owner &&
					(snapshot.seq > this.activitySeq ||
						(snapshot.seq === this.activitySeq && revision.revision > this.activityRevision))
				: newer;
		if (newer) {
			// An unfamiliar owner cannot smuggle activity in alongside an independently newer durable state.
			// Deliberate: a newer state from another owner also drops the bound owner's activity, so the footer
			// shows no activity rather than one it has no evidence for, until the bound owner's next update or a
			// rebind from the authoritative `session.lifecycle`.
			this.snapshot = { ...snapshot, activity: undefined, activityRevision: undefined };
		}
		if (acceptedActivity && this.snapshot) {
			this.snapshot = { ...this.snapshot, activity: snapshot.activity, activityRevision: revision };
			this.activitySeq = snapshot.seq;
			this.activityRevision = revision?.revision ?? -1;
		}
	}

	text(): string | undefined {
		const snapshot = this.snapshot;
		if (!snapshot) return undefined;
		const parts: string[] = [snapshot.state];
		const waits = snapshot.waitingOn;
		if (waits) {
			if (waits.children > 0) parts.push(`children: ${waits.children}`);
			for (const source of [...(waits.childSources ?? []), ...waits.background]) {
				parts.push(`${source.source}: ${source.activeCount}`);
				for (const item of source.items ?? []) parts.push(item.label ?? item.id);
				if (source.omittedItems) parts.push(`+${source.omittedItems} named items`);
			}
			for (const child of waits.childReports ?? []) parts.push(`${child.label ?? child.taskId}: ${child.state}`);
			if (waits.childReportsOmitted) parts.push(`+${waits.childReportsOmitted} child reports`);
			for (const wait of waits.human) parts.push(wait.childLabel ? `${wait.kind}: ${wait.childLabel}` : wait.kind);
		}
		const stop = snapshot.lastStop;
		if (stop) {
			const detail = stop.deadline ?? stop.guard ?? stop.todo ?? stop.abortSource;
			parts.push(`${stop.cause}${detail ? `: ${detail}` : ""}`);
		}
		if (snapshot.failure)
			parts.push(`${snapshot.failure.reason}${snapshot.failure.taskId ? `: ${snapshot.failure.taskId}` : ""}`);
		const activity = snapshot.activity;
		if (activity?.kind === "tool")
			parts.push(`activity: ${activity.toolName} (outstanding: ${activity.outstanding})`);
		else if (activity?.kind === "model") parts.push("activity: model");
		return sanitizeTerminalLabel(parts.join(" · "));
	}
}
