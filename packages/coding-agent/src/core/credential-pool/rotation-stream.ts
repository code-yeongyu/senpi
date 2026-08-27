import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Credential } from "@earendil-works/pi-ai";
import { rendezvousOrder, type SlotHasher } from "@earendil-works/pi-ai/auth/pool/select";
import { listSlots as listCredentialSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { type CredentialBlock, classifyCredentialFailure } from "./classify.ts";
import { discoverEnvSlots } from "./env-slots.ts";
import { type RunSlot, runCredentialFailover } from "./failover.ts";
import type { CredentialSlotRepository, CredentialSlotState } from "./state-store.ts";

/** The exact hash the claude-sdk-oauth affinity oracle uses, so pools never remap. */
export const sha256SlotHasher: SlotHasher = (input) => createHash("sha256").update(input).digest().readBigUInt64BE(0);

export type RotationLane = "stored" | "env";

export type RotationSlot = RunSlot & {
	lane: RotationLane;
	/** Env-lane key material for the attempt; never serialized or persisted. */
	envKey?: string;
	envVarName?: string;
};

export type RotationSources = {
	providerId: string;
	credential: Credential | undefined;
	env: (name: string) => string | undefined;
	repository: CredentialSlotRepository;
	now?: () => number;
};

function overlayState(slot: RotationSlot, state: CredentialSlotState | undefined): RotationSlot {
	if (!state) return slot;
	return {
		...slot,
		...(state.blockedUntil === undefined ? {} : { blockedUntil: state.blockedUntil }),
		...(state.blockReason === undefined ? {} : { blockReason: state.blockReason }),
		...(state.failureCount === undefined ? {} : { failureCount: state.failureCount }),
	};
}

/**
 * Lists the provider's rotation slots with sidecar health overlaid. Stored
 * credentials own the lane when present; env slots participate only when
 * nothing is stored, preserving today's resolution precedence. An env slot's
 * persisted health applies only while its HMAC revision still matches the
 * current env value, so rotating a key in place clears its own stale block.
 */
export async function listRotationSlots(sources: RotationSources): Promise<RotationSlot[]> {
	const { providerId, credential, env, repository } = sources;
	if (credential) {
		const state = await repository.listSlots(providerId, "stored");
		return listCredentialSlots(credential).map((slot) =>
			overlayState({ name: slot.name, lane: "stored" }, state[slot.name]),
		);
	}
	const envSlots = discoverEnvSlots(providerId, env);
	if (envSlots.length === 0) return [];
	const state = await repository.listSlots(providerId, "env");
	const slots: RotationSlot[] = [];
	for (const slot of envSlots) {
		const persisted = state[slot.name];
		const revision = await repository.envCredentialRevision(slot.envVarName, slot.key);
		const applicable = persisted?.credentialRevision === revision ? persisted : undefined;
		slots.push(
			overlayState({ name: slot.name, lane: "env", envKey: slot.key, envVarName: slot.envVarName }, applicable),
		);
	}
	return slots;
}

function blockPatch(
	block: CredentialBlock,
	current: CredentialSlotState | undefined,
	now: number,
	credentialRevision?: string,
): Omit<CredentialSlotState, "stateVersion"> {
	const failureCount = (current?.failureCount ?? 0) + 1;
	const base = {
		failureCount,
		...(credentialRevision === undefined ? {} : { credentialRevision }),
		...(current?.lastSuccessAt === undefined ? {} : { lastSuccessAt: current.lastSuccessAt }),
	};
	if (block.reason === "rate_limit") {
		return { ...base, blockedUntil: now + block.cooldownMs, blockReason: "rate_limit" };
	}
	return { ...base, blockReason: block.reason };
}

export type CredentialRotationOptions = {
	sources: RotationSources;
	/** Stable session key keeps a session on its slot; absent, each request distributes. */
	affinityKey?: string;
	hasher?: SlotHasher;
	runAttempt: (
		slot: RotationSlot,
	) => AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>;
};

function errorFromEvent(event: AssistantMessageEvent): unknown {
	if (event.type !== "error") return undefined;
	const message = event.error.errorMessage ?? "provider stream error";
	return new Error(message);
}

/**
 * In-lane credential rotation for one provider request. Selection follows the
 * HRW order for the affinity key; only the `start` bookkeeping event counts as
 * pre-commit, so any delta bars silent rotation (default-DENY) and failures
 * after output carry the turn-retry suppression marker.
 */
export function streamWithCredentialRotation(
	options: CredentialRotationOptions,
): AsyncGenerator<AssistantMessageEvent> {
	const { sources, runAttempt } = options;
	const hasher = options.hasher ?? sha256SlotHasher;
	const affinityKey = options.affinityKey ?? randomUUID();
	const now = sources.now ?? Date.now;

	return runCredentialFailover<AssistantMessageEvent, RotationSlot>({
		listSlots: () => listRotationSlots(sources),
		select: (candidates) => {
			const ordered = rendezvousOrder(affinityKey, candidates, hasher);
			const winner = ordered[0];
			if (!winner) throw new Error("credential rotation selected from an empty candidate set");
			return winner;
		},
		runAttempt,
		isCommittedOutput: (event) => event.type !== "start",
		errorFromEvent,
		classify: classifyCredentialFailure,
		persistBlock: async (slot, block) => {
			const revision =
				slot.lane === "env" && slot.envVarName !== undefined && slot.envKey !== undefined
					? await sources.repository.envCredentialRevision(slot.envVarName, slot.envKey)
					: undefined;
			await sources.repository.mutateSlotState(sources.providerId, slot.lane, slot.name, (current) =>
				blockPatch(block, current, now(), revision),
			);
		},
		now,
	});
}
