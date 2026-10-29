import { serializeJsonLine } from "./jsonl.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import type { RecoveryStreamState } from "./compact-recovery-types.ts";
import { SocketEventSinkActor } from "./socket-event-fanout.ts";

/** Every enqueue path, including startup UI/lifecycle and compaction replacements, uses the same route.
 * IDs are a subset of the bounded epoch attempt index; GlobalResync's legacy cursor bypasses enqueue.
 */
export class AdmissionRoutingActor extends SocketEventSinkActor {
	readonly admissions = new Set<string>();
	// Terminal reply debt can enqueue after S08 retires the stream. Headers only, bounded by epoch admission IDs;
	// this is neither another counter nor an attempt index, and cancelled answers never consult it.
	private readonly terminal = new Map<string, RecoveryStreamState>();

	remember(sessionId: string, checkpoints: RecoveryCheckpoints, socketEpoch: string): RecoveryStreamState | undefined {
		const stream = checkpoints.stream({ socketEpoch, sessionId });
		const routes = stream?.routes.filter((id) => this.admissions.has(id)) ?? [];
		if (stream && routes.length > 0) this.terminal.set(sessionId, { ...stream, routes });
		return stream ? { ...stream, routes } : this.terminal.get(sessionId);
	}

	route(line: string, checkpoints: RecoveryCheckpoints, socketEpoch: string): readonly string[] {
		if (this.admissions.size === 0) return [line];
		const record: Record<string, unknown> = JSON.parse(line);
		if (typeof record.sessionId !== "string" || record.admissionId !== undefined) return [line];
		if (typeof record.subscriptionId === "string") return [line];
		const stream = this.remember(record.sessionId, checkpoints, socketEpoch);
		const routes = stream?.routes.filter((id) => this.admissions.has(id)) ?? [];
		return routes.length === 0
			? [line]
			: routes.map((admissionId) => serializeJsonLine({ ...record, admissionId, generation: stream?.generation }));
	}

	bind(checkpoints: RecoveryCheckpoints, socketEpoch: string): void {
		const enqueue = super.enqueue.bind(this);
		this.enqueue = (line, key, written, demoted, reply, held) => {
			const lines = this.route(line, checkpoints, socketEpoch);
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
