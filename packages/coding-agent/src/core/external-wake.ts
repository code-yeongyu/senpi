import type {
	ExternalWakeDetails,
	ExternalWakePermit,
	ExternalWakeRefusal,
	ExternalWakeRefusalReason,
	ExternalWakeResult,
	ExternalWakeSource,
	RegisterExternalWakeSourceOptions,
} from "./extensions/session-control-types.ts";
import { SESSION_CONTROL_EXTERNAL_WAKE_TYPE } from "./extensions/session-control-types.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";

/** Only native state appears here; the source cannot supply its own revisions. */
export interface ExternalWakeSnapshot {
	readonly sessionId: string;
	readonly turnEpoch: number;
	readonly editorRevision: number;
	readonly abortGeneration: number;
	readonly holdGeneration: number;
	readonly admissionGeneration: number;
	readonly busy: boolean;
	readonly held: boolean;
	readonly closed: boolean;
	readonly supported: boolean;
}

export interface NativeExternalWake {
	readonly source: string;
	readonly readTool: string;
	readonly wake_id: string;
	readonly signal: AbortSignal;
	/** Re-sampled after every asynchronous preparation and immediately before claiming the run. */
	readonly refusal: () => ExternalWakeRefusal | undefined;
}

export interface ExternalWakePort {
	/** A preparing request ignores only its own session-work hold; new requests never ignore it. */
	readonly snapshot: (preparing?: boolean) => ExternalWakeSnapshot;
	readonly hasActiveTool: (name: string) => boolean;
	readonly written: () => ReadonlyMap<string, number>;
	readonly start: (wake: NativeExternalWake) => Promise<ExternalWakeResult>;
}

interface PermitState {
	readonly snapshot: ExternalWakeSnapshot;
	readonly deadline: number;
	readonly signal?: AbortSignal;
	wakeId?: string;
}

const identifier = /^[A-Za-z0-9_.:/-]{1,128}$/;
const refusal = (reason: ExternalWakeRefusalReason): ExternalWakeRefusal => ({ status: "refused", reason });
const wakeKey = (source: string, id: string): string => JSON.stringify([source, id]);

/** A memoized fold, not a second delivery queue. Replaying these receipts never schedules a run. */
export const writtenExternalWakes: HistoryReducer<Map<string, number>> = {
	initial: () => new Map(),
	add: (written, entry) => {
		if (entry.type !== "custom_message" || entry.customType !== SESSION_CONTROL_EXTERNAL_WAKE_TYPE) return written;
		const details = entry.details as Partial<ExternalWakeDetails> | undefined;
		if (
			typeof details?.source === "string" &&
			typeof details.wake_id === "string" &&
			typeof details.turn_epoch === "number"
		)
			written.set(wakeKey(details.source, details.wake_id), details.turn_epoch);
		return written;
	},
};

/** Session-owned, text-free wake admission. Permits are bound to the source and its extension generation. */
export class ExternalWake {
	private readonly registrations = new Map<string, ExternalWakeSource>();
	private readonly results = new Map<string, Promise<ExternalWakeResult>>();
	private readonly port: ExternalWakePort;
	constructor(port: ExternalWakePort) {
		this.port = port;
	}

	register(options: RegisterExternalWakeSourceOptions): ExternalWakeSource {
		const { source, readTool } = options;
		if (!identifier.test(source) || !identifier.test(readTool))
			throw new Error("External wake source and read tool must be bounded identifiers (1-128 characters).");
		if (this.registrations.has(source)) throw new Error(`External wake source is already registered: ${source}`);
		const lifetime = new AbortController();
		const permits = new WeakMap<ExternalWakePermit, PermitState>();
		const inspect = (permit?: PermitState, preparing = false): ExternalWakeRefusal | undefined => {
			if (lifetime.signal.aborted) return refusal("stale");
			if (permit?.signal?.aborted) return refusal("aborted");
			if (permit && Date.now() >= permit.deadline) return refusal("expired");
			const current = this.port.snapshot(preparing);
			if (current.closed) return refusal("stale");
			if (permit) {
				const prior = permit.snapshot;
				if (
					current.sessionId !== prior.sessionId ||
					current.turnEpoch !== prior.turnEpoch ||
					current.editorRevision !== prior.editorRevision ||
					current.abortGeneration !== prior.abortGeneration ||
					current.holdGeneration !== prior.holdGeneration ||
					current.admissionGeneration !== prior.admissionGeneration
				)
					return refusal("stale");
			}
			if (current.held) return refusal("held");
			if (current.busy) return refusal("busy");
			if (!current.supported) return refusal("unsupported");
			if (!this.port.hasActiveTool(readTool)) return refusal("tool_unavailable");
			return undefined;
		};
		const registration: ExternalWakeSource = {
			prepare: ({ deadline, signal }) => {
				if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 60_000)
					return refusal("expired");
				if (signal?.aborted) return refusal("aborted");
				const refused = inspect();
				if (refused) return refused;
				const permit = Object.freeze({}) as ExternalWakePermit;
				permits.set(permit, { snapshot: this.port.snapshot(), deadline, signal });
				return { status: "ready", permit };
			},
			wake: ({ wake_id, permit }) => {
				const state = permits.get(permit);
				if (!identifier.test(wake_id) || !state || (state.wakeId !== undefined && state.wakeId !== wake_id))
					return Promise.resolve(refusal("invalid_permit"));
				state.wakeId = wake_id;
				const key = wakeKey(source, wake_id);
				const sessionKey = JSON.stringify([state.snapshot.sessionId, key]);
				const prior = this.results.get(sessionKey);
				if (prior) return prior;
				const written = this.port.written().get(key);
				if (written !== undefined) return Promise.resolve({ status: "started", turn_epoch: written });
				const result = Promise.withResolvers<ExternalWakeResult>();
				// Reserve before start: a reentrant or concurrent repeat always joins the first intent.
				this.results.set(sessionKey, result.promise);
				const refused = inspect(state);
				if (refused) result.resolve(refused);
				else {
					const signal = state.signal ? AbortSignal.any([lifetime.signal, state.signal]) : lifetime.signal;
					void this.port
						.start({ source, readTool, wake_id, signal, refusal: () => inspect(state, true) })
						.then(result.resolve, (error: unknown) =>
							result.resolve({
								status: "failed",
								error: error instanceof Error ? error.message : String(error),
							}),
						);
				}
				return result.promise;
			},
			dispose: () => {
				lifetime.abort();
				if (this.registrations.get(source) === registration) this.registrations.delete(source);
			},
		};
		this.registrations.set(source, registration);
		return registration;
	}
}
