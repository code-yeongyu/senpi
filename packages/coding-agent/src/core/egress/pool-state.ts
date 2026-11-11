import type {
	CredentialSlotRepository,
	CredentialSlotState,
	StoredSlotRevisions,
} from "../credential-pool/state-store.ts";

/**
 * The credential-pool health that rotation reads and writes (senpi#5835): cooldowns, half-open probe leases and
 * the revisions they are keyed by. On one machine it is the file-backed `CredentialSlotRepository`; a hosted brain
 * supplies its own durable state behind the same calls.
 */
export interface PoolState {
	listSlots(providerId: string, laneId: string): Promise<Record<string, CredentialSlotState>>;
	/** Atomic read-modify-write of one slot; `stateVersion` increments on every write, undefined removes the slot. */
	mutateSlotState(
		providerId: string,
		laneId: string,
		slotId: string,
		fn: (current: CredentialSlotState | undefined) => Omit<CredentialSlotState, "stateVersion"> | undefined,
	): Promise<CredentialSlotState | undefined>;
	storedSlotRevisions(
		providerId: string,
		slotName: string,
		material: { key?: string; access?: string; refresh?: string },
	): Promise<StoredSlotRevisions>;
	envCredentialRevision(envVarName: string, envValue: string): Promise<string>;
}

// Compile-time proof that the fused implementation is today's repository, used as is.
const fusedPoolState = (repository: CredentialSlotRepository): PoolState => repository;
void fusedPoolState;
