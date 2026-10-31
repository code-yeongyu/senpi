/**
 * The `effect_status` record and the pending-transition bus behind it.
 *
 * Effect and admission ledgers call `noteSessionEffect` the moment they persist a transition. Each
 * multi-session host installs its own sink and owns the sessions it holds; ownership is decided when the
 * transition is noted, so a transition of a session no installed sink owns at that moment (classic stdio, a
 * worker isolate, a replaced session, or one whose runtime is not registered yet) is dropped. A ledger must
 * therefore not record receipts before its session is registered with a host.
 *
 * A held transition reaches `effects: true` subscriptions only AFTER the session record that caused it is on
 * the connection's FIFO. Two drain points guarantee that ordering: the writer's post-publish hook drains a
 * session's notes right after each session record it publishes, and a coalesced microtask flush covers
 * transitions a ledger records from inside a session event (an `agent_idle` seal, a `model_changed`), which
 * always run after that event's record was enqueued. The command's own response is never the causing record.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import type { EffectStatus } from "./effect-record.ts";

/** One `effect_status` record as it travels on the wire (docs/rpc.md, "Session status stream"). */
export interface SessionEffectStatusRecord {
	readonly type: "effect_status";
	readonly subscriptionId: string;
	readonly seq: number;
	readonly sessionId: string;
	readonly effectId: string;
	readonly kind: EffectStatus["kind"];
	readonly state: EffectStatus["state"];
	readonly disposition?: string;
	readonly outcome?: EffectStatus["outcome"];
	readonly by?: EffectStatus["by"];
	readonly at: string;
}

export function effectStatusRecord(
	subscription: { readonly id: string; readonly seq: number },
	sessionId: string,
	status: EffectStatus,
	at: string,
): SessionEffectStatusRecord {
	return {
		type: "effect_status",
		subscriptionId: subscription.id,
		seq: subscription.seq,
		sessionId,
		effectId: status.effectId,
		kind: status.kind,
		state: status.state,
		...(status.disposition === undefined ? {} : { disposition: status.disposition }),
		...(status.outcome === undefined ? {} : { outcome: status.outcome }),
		...(status.by === undefined ? {} : { by: status.by }),
		at,
	};
}

/** A host that publishes `effect_status` for the sessions it owns. */
export interface SessionEffectSink {
	owns(session: AgentSession): boolean;
	flush(session: AgentSession, statuses: readonly EffectStatus[]): void;
}

const sinks = new Set<SessionEffectSink>();
const pending = new WeakMap<AgentSession, EffectStatus[]>();
const dirty = new Map<AgentSession, SessionEffectSink>();
let scheduled = false;

/**
 * A ledger persisted a transition: hold it until the causing record is published, then deliver. A session
 * no installed sink owns (classic stdio, a worker isolate, a session already replaced) has no reader, so its
 * transition is dropped rather than held for the life of the process.
 */
export function noteSessionEffect(session: AgentSession, status: EffectStatus): void {
	let owner: SessionEffectSink | undefined;
	for (const sink of sinks) {
		if (!sink.owns(session)) continue;
		owner = sink;
		break;
	}
	if (owner === undefined) return;
	const list = pending.get(session) ?? [];
	list.push(status);
	pending.set(session, list);
	dirty.set(session, owner);
	if (!scheduled) {
		scheduled = true;
		queueMicrotask(flushDirty);
	}
}

/** Take a session's held transitions; the writer calls this right after publishing its causing record. */
export function drainSessionEffects(session: AgentSession): readonly EffectStatus[] {
	const list = pending.get(session) ?? [];
	if (list.length > 0) pending.set(session, []);
	return list;
}

function flushDirty(): void {
	scheduled = false;
	for (const [session, sink] of [...dirty]) {
		dirty.delete(session);
		const drained = drainSessionEffects(session);
		if (drained.length > 0 && sinks.has(sink)) sink.flush(session, drained);
	}
}

/** Each host installs its own sink; the returned function removes it (and stops holding for its sessions). */
export function installSessionEffectSink(sink: SessionEffectSink): () => void {
	sinks.add(sink);
	return () => {
		sinks.delete(sink);
		for (const [session, owner] of [...dirty]) {
			if (owner !== sink) continue;
			dirty.delete(session);
			drainSessionEffects(session);
		}
	};
}
