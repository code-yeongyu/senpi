import { type RecoveryCarrier, recoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { CanonicalRecord, CanonicalUnit } from "./compact-lane-transitions.ts";

const CONTROLS = new Set(["message_block_state", "message_block_metadata", "message_tool_arguments_reset"]);
const carried = new WeakMap<object, CanonicalRecord>();

export interface CanonicalControl {
	readonly record: CanonicalRecord;
	readonly carrier: RecoveryCarrier;
}

/**
 * Joins the two projections of one session event into one acceptance unit (RULING-26 Q2). The structured lane emits
 * before the legacy listeners, so an event's canonical record waits here, keyed by the per-event recovery carrier both
 * projections share, until its legacy record arrives; a block control has no legacy record and is a unit by itself.
 * Canonical records take JSON wire semantics at this boundary: `undefined` properties are dropped (#4425 LOW 4).
 */
export class CanonicalPairing {
	private readonly pending = new WeakMap<RecoveryCarrier, CanonicalRecord>();

	structured(record: object): CanonicalControl | undefined {
		const carrier = recoveryCarrier(record);
		if (!carrier) return undefined;
		const canonical: CanonicalRecord = JSON.parse(JSON.stringify(record));
		if (CONTROLS.has(canonical.type)) return { record: canonical, carrier };
		this.pending.set(carrier, canonical);
		return undefined;
	}

	take(legacy: object): CanonicalRecord | undefined {
		const carrier = recoveryCarrier(legacy);
		const canonical = carrier && this.pending.get(carrier);
		if (carrier) this.pending.delete(carrier);
		return canonical;
	}
}

/** A worker binding hands the paired canonical record to its frame writer beside the unchanged legacy record. */
export function carryCanonical(legacy: object, canonical: CanonicalRecord): void {
	carried.set(legacy, canonical);
}

export function carriedCanonical(legacy: object): CanonicalRecord | undefined {
	return carried.get(legacy);
}

/** The canonical unit a worker frame carries, when it carries one. */
export function frameUnit(frame: {
	readonly ordinal?: number;
	readonly firstOrdinal?: number;
	readonly recovery?: RecoveryCarrier;
	readonly canonical?: CanonicalRecord;
}): CanonicalUnit | undefined {
	const { ordinal, firstOrdinal, recovery, canonical } = frame;
	return canonical && recovery && ordinal !== undefined && firstOrdinal !== undefined
		? { record: canonical, carrier: recovery, ordinal, firstOrdinal }
		: undefined;
}
