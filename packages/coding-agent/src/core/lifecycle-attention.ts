import type { HumanWait } from "./session-lifecycle-types.ts";
import { isRecord } from "./work-custody-record.ts";

export interface SyntheticAttention {
	readonly key: string;
	readonly wait: HumanWait;
}

/** Occurrence identity outlives clients, turns, and process restarts. */
export class LifecycleAttention {
	private readonly open = new Map<string, HumanWait>();
	private sequence: number;
	private readonly sessionId: string;
	constructor(
		sessionId: string,
		restored?: { readonly attentionSeq: number; readonly synthetic: readonly SyntheticAttention[] },
	) {
		this.sessionId = sessionId;
		this.sequence = restored?.attentionSeq ?? 0;
		for (const occurrence of restored?.synthetic ?? []) this.open.set(occurrence.key, occurrence.wait);
	}

	get attentionSeq(): number {
		return this.sequence;
	}

	get synthetic(): readonly SyntheticAttention[] {
		return [...this.open].map(([key, wait]) => ({ key, wait }));
	}

	reconcile(requests: readonly { readonly key: string; readonly kind: HumanWait["kind"] }[]): readonly HumanWait[] {
		const wanted = new Set(requests.map((request) => request.key));
		for (const key of this.open.keys()) if (!wanted.has(key)) this.open.delete(key);
		return requests.map(({ key, kind }) => {
			const existing = this.open.get(key);
			if (existing?.kind === kind) return existing;
			const wait: HumanWait = {
				kind,
				originSessionId: this.sessionId,
				requestId: `${key}:${++this.sequence}`,
				revision: 1,
				since: new Date().toISOString(),
			};
			this.open.set(key, wait);
			return wait;
		});
	}
}

export function readHumanWait(value: unknown): HumanWait | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.kind) {
		case "question":
		case "approval":
		case "goal_blocked":
		case "goal_paused":
		case "stalled":
		case "interrupted_run":
			break;
		default:
			return undefined;
	}
	if (
		typeof value.originSessionId !== "string" ||
		typeof value.requestId !== "string" ||
		typeof value.revision !== "number" ||
		typeof value.since !== "string"
	)
		return undefined;
	return {
		kind: value.kind,
		originSessionId: value.originSessionId,
		requestId: value.requestId,
		revision: value.revision,
		since: value.since,
		...(typeof value.childSessionId === "string" ? { childSessionId: value.childSessionId } : {}),
		...(typeof value.childLabel === "string" ? { childLabel: value.childLabel } : {}),
	};
}
