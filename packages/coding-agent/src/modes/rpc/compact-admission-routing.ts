import { serializeJsonLine } from "./jsonl.ts";
import { replyAdmission } from "./compact-admission-reply.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import type { RecoveryStreamState } from "./compact-recovery-types.ts";
import { SocketEventSinkActor } from "./socket-event-fanout.ts";

/** Every enqueue path, including startup UI/lifecycle and compaction replacements, uses the same route.
 * IDs are a subset of the bounded epoch attempt index; GlobalResync's legacy cursor bypasses enqueue.
 */
export class AdmissionRoutingActor extends SocketEventSinkActor {
	private peer: string | undefined;
	readonly admissions = new Set<string>();
	// Terminal reply debt can enqueue after S08 retires the stream. Headers only, bounded by epoch admission IDs;
	// this is neither another counter nor an attempt index, and cancelled answers never consult it.
	private readonly terminal = new Map<string, RecoveryStreamState>();

	remember(sessionId: string, checkpoints: RecoveryCheckpoints, socketEpoch: string): RecoveryStreamState | undefined {
		const stream = checkpoints.stream({ socketEpoch, sessionId });
		const remembered = stream ?? this.terminal.get(sessionId);
		const routes = remembered?.routes.filter((id) => this.admissions.has(id)) ?? [];
		if (stream && routes.length > 0) this.terminal.set(sessionId, { ...stream, routes });
		return remembered ? { ...remembered, routes } : undefined;
	}

	route(line: string, checkpoints: RecoveryCheckpoints, socketEpoch: string): readonly string[] {
		if (this.admissions.size === 0) return [line];
		const record: Record<string, unknown> = JSON.parse(line);
		if (typeof record.sessionId !== "string" || record.admissionId !== undefined) return [line];
		if (typeof record.subscriptionId === "string") return [line];
		const stream = this.remember(record.sessionId, checkpoints, socketEpoch);
		const routes = stream?.routes.filter((id) => this.admissions.has(id)) ?? [];
		if (record.type === "response" && typeof record.id === "string") {
			const admissionId = replyAdmission(record.id, this.peer, routes);
			if (admissionId === null) return [];
			return admissionId === undefined
				? [line]
				: [serializeJsonLine({ ...record, admissionId, generation: stream?.generation })];
		}
		return routes.length === 0
			? [line]
			: routes.map((admissionId) => serializeJsonLine({ ...record, admissionId, generation: stream?.generation }));
	}

	bind(checkpoints: RecoveryCheckpoints, socketEpoch: string, peer: string): void {
		this.peer = peer;
		const enqueue = super.enqueue.bind(this);
		this.enqueue = (line, key, written, demoted, reply, held) => {
			const lines = this.route(line, checkpoints, socketEpoch);
			if (lines.length === 0) {
				written?.(false);
				return;
			}
			const replacements = demoted === undefined ? undefined : this.route(demoted, checkpoints, socketEpoch);
			let remaining = lines.length;
			let delivered = false;
			const receipt = (ok: boolean) => {
				delivered ||= ok;
				if (--remaining === 0) written?.(delivered);
			};
			for (let i = 0; i < lines.length; i++)
				enqueue(
					lines[i] ?? line,
					key === undefined ? undefined : `${key}:${i}`,
					receipt,
					replacements?.[i],
					reply,
					held,
				);
		};
	}
}
