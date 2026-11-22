import { type RecoveryCarrier, recoveryCarrier } from "../../core/session-recovery-identity.ts";
import type { CanonicalRecord, CanonicalUnit } from "./compact-lane-transitions.ts";
import { protocolClone, protocolDepthLimitOf } from "./compact-protocol-depth.ts";

const CONTROLS = new Set(["message_block_state", "message_block_metadata", "message_tool_arguments_reset"]);
const carried = new WeakMap<object, CanonicalRecord>();
const carriedRefusals = new WeakSet<object>();

export interface CanonicalControl {
	readonly record: CanonicalRecord;
	readonly carrier: RecoveryCarrier;
}

/**
 * Joins the two projections of one session event into one acceptance unit (RULING-26 Q2). The structured lane emits
 * before the legacy listeners, so an event's canonical record waits here, keyed by the per-event recovery carrier both
 * projections share, until its legacy record arrives; a block control has no legacy record and is a unit by itself.
 * Canonical records take JSON wire semantics at this boundary: `undefined` properties are dropped (#4425 LOW 4), and a
 * record deeper than the protocol depth limit is refused typed before its clone and never pairs (RULING-59 C). The
 * caller reports that refusal; `refused` then tells the event's legacy record, so the event is counted once.
 */
export class CanonicalPairing {
	private readonly pending = new WeakMap<RecoveryCarrier, CanonicalRecord>();
	private readonly refusals = new WeakSet<RecoveryCarrier>();

	structured(record: object): CanonicalControl | undefined {
		const carrier = recoveryCarrier(record);
		if (!carrier) return undefined;
		let canonical: CanonicalRecord;
		try {
			canonical = protocolClone(record);
		} catch (cause) {
			if (protocolDepthLimitOf(cause) !== undefined) this.refusals.add(carrier);
			throw cause;
		}
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

	/** Whether the canonical record of `legacy`'s event was refused at the protocol depth limit (and reported). */
	refused(legacy: object): boolean {
		const carrier = recoveryCarrier(legacy);
		return carrier !== undefined && this.refusals.delete(carrier);
	}
}

/**
 * A worker binding hands the paired canonical record, or the fact that the pairing refused it at the depth limit, to
 * its frame writer beside the unchanged legacy record.
 */
export function carryCanonical(legacy: object, canonical: CanonicalRecord | undefined, refused: boolean): void {
	if (canonical) carried.set(legacy, canonical);
	if (refused) carriedRefusals.add(legacy);
}

export function carriedCanonical(legacy: object): CanonicalRecord | undefined {
	return carried.get(legacy);
}

export function carriedRefusal(legacy: object): boolean {
	return carriedRefusals.has(legacy);
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
