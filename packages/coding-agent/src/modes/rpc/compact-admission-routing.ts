import { serializeJsonLine } from "./jsonl.ts";
import { replyAdmission } from "./compact-admission-reply.ts";
import type { RecoveryCheckpoints } from "./compact-recovery-state.ts";
import type { RecoveryStreamState } from "./compact-recovery-types.ts";
import { SocketEventSinkActor } from "./socket-event-fanout.ts";
import type { MirrorPending } from "./compact-mirror-pending.ts";

/** Every enqueue path, including startup UI/lifecycle and compaction replacements, uses the same route.
 * IDs are a subset of the bounded epoch attempt index; GlobalResync's legacy cursor bypasses enqueue.
 */
export class AdmissionRoutingActor extends SocketEventSinkActor {
	private peer: string | undefined;
	readonly admissions = new Set<string>();
	readonly subscriptions = new Map<string, string>();
	readonly mirrorOwners = new Map<string, string>();
	readonly pendingMirrors = new Map<string, MirrorPending>();
	/** RULING-117: per session, the completed open that routes it on this socket and how that open ends. */
	readonly opened = new Map<string, { readonly admissionId: string; readonly end: () => Promise<void> }>();
	/** RULING-118: per request id, the route a detach of that request retires once the request's reply is routed. */
	private readonly retireAfterReply = new Map<string, () => void>();
	mirrorAdmissions?: (sessionId: string, recordType: string) => readonly string[];
	// Terminal reply debt can enqueue after S08 retires the stream. Headers only, bounded by epoch admission IDs;
	// this is neither another counter nor an attempt index, and cancelled answers never consult it.
	private readonly terminal = new Map<string, RecoveryStreamState>();

	override close(): void {
		this.subscriptions.clear();
		this.mirrorOwners.clear();
		for (const pending of this.pendingMirrors.values()) pending.retire();
		this.pendingMirrors.clear();
		this.admissions.clear();
		this.opened.clear();
		this.retireAfterReply.clear();
		this.terminal.clear();
		super.close();
	}

	remember(sessionId: string, checkpoints: RecoveryCheckpoints, socketEpoch: string): RecoveryStreamState | undefined {
		const stream = checkpoints.stream({ socketEpoch, sessionId });
		const remembered = stream ?? this.terminal.get(sessionId);
		const routes =
			remembered?.routes.filter((id) => this.admissions.has(id) || [...this.mirrorOwners.values()].includes(id)) ??
			[];
		if (stream && routes.length > 0) this.terminal.set(sessionId, { ...stream, routes });
		return remembered ? { ...remembered, routes } : undefined;
	}

	route(line: string, checkpoints: RecoveryCheckpoints, socketEpoch: string): readonly string[] {
		if (this.admissions.size === 0 && this.subscriptions.size === 0 && this.mirrorOwners.size === 0) return [line];
		const record: Record<string, unknown> = JSON.parse(line);
		if (typeof record.sessionId !== "string" || record.admissionId !== undefined) return [line];
		if (typeof record.subscriptionId === "string") {
			const subscription = this.subscriptions.get(record.subscriptionId);
			return subscription === undefined
				? [line]
				: [serializeJsonLine({ ...record, admissionId: subscription, generation: 0 })];
		}
		const mirrors =
			record.type === "response" ? [] : (this.mirrorAdmissions?.(record.sessionId, String(record.type)) ?? []);
		const stream = this.remember(record.sessionId, checkpoints, socketEpoch);
		const terminal = record.type === "session_closed" || record.type === "session_parked";
		const routes = [
			...new Set([
				...(stream?.routes ?? []).filter(
					(id) => this.admissions.has(id) || (terminal && [...this.mirrorOwners.values()].includes(id)),
				),
				...mirrors,
			]),
		];
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

	/** A detach made by request `id` retires its route after that request's reply took the route's tag. */
	deferRetire(id: string, retire: () => void): void {
		this.retireAfterReply.set(id, retire);
	}

	private retireReplied(line: string): void {
		if (this.retireAfterReply.size === 0) return;
		const record: Record<string, unknown> = JSON.parse(line);
		if (record.type !== "response" || typeof record.id !== "string") return;
		const retire = this.retireAfterReply.get(record.id);
		this.retireAfterReply.delete(record.id);
		retire?.();
	}

	bind(checkpoints: RecoveryCheckpoints, socketEpoch: string, peer: string): void {
		this.peer = peer;
		const enqueue = super.enqueue.bind(this);
		this.enqueue = (line, key, written, demoted, reply, held) => {
			const lines = this.route(line, checkpoints, socketEpoch);
			this.retireReplied(line);
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
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i] ?? "";
				const admissionId: unknown = Reflect.get(JSON.parse(line), "admissionId");
				const pending = typeof admissionId === "string" ? this.pendingMirrors.get(admissionId) : undefined;
				const deliver = () =>
					enqueue(
						lines[i] ?? line,
						key === undefined ? undefined : `${key}:${i}`,
						receipt,
						replacements?.[i],
						reply,
						held,
					);
				if (pending && !reply) pending.enqueue(line, deliver, () => receipt(false));
				else deliver();
			}
		};
	}
}
