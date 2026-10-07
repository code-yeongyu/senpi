import { createHash, randomUUID } from "node:crypto";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { rendezvousOrder, type SlotHasher } from "@earendil-works/pi-ai/auth/pool/select";
import { type CredentialBlock, classifyCredentialFailure } from "./classify.ts";
import { runCredentialFailover } from "./failover.ts";
import { modelBlockKey, pruneModelBlocks, withModelBlock } from "./model-scope.ts";
import { isCommittedRotationOutput, isRotationStreamStart, rotationErrorFromEvent } from "./rotation-events.ts";
import { listRotationSlots, type RotationSlot, type RotationSources } from "./rotation-slots.ts";
import type { CredentialSlotState } from "./state-store.ts";

export { listRotationSlots, type RotationLane, type RotationSlot, type RotationSources } from "./rotation-slots.ts";

/** The exact hash the claude-sdk-oauth affinity oracle uses, so pools never remap. */
export const sha256SlotHasher: SlotHasher = (input) => createHash("sha256").update(input).digest().readBigUInt64BE(0);

/**
 * A limit naming one model family lands on that family only: the slot's own
 * health (account block, failure count) is kept as it was, so the slot keeps
 * serving every other model. A half-open probe lease this attempt held is
 * released so the next caller can probe the slot for another model.
 */
function modelBlockPatch(
	family: string,
	modelId: string,
	blockedUntil: number,
	current: CredentialSlotState | undefined,
	now: number,
	credentialRevision?: string,
): Omit<CredentialSlotState, "stateVersion"> {
	const sameMaterial = current !== undefined && current.credentialRevision === credentialRevision;
	const { stateVersion: _stateVersion, ...kept } = sameMaterial ? current : { stateVersion: 0 };
	return {
		...kept,
		lease: undefined,
		...(credentialRevision === undefined ? {} : { credentialRevision }),
		modelBlocks: withModelBlock(
			sameMaterial ? current.modelBlocks : undefined,
			modelBlockKey(family, modelId),
			blockedUntil,
			now,
		),
	};
}

function blockPatch(
	block: CredentialBlock,
	current: CredentialSlotState | undefined,
	now: number,
	credentialRevision?: string,
	policy?: { cooldownBaseMs?: number; cooldownCapMs?: number },
	modelId?: string,
): Omit<CredentialSlotState, "stateVersion"> {
	if (block.reason === "rate_limit" && block.modelFamily !== undefined && modelId !== undefined) {
		const blockedUntil = now + Math.min(policy?.cooldownCapMs ?? block.cooldownMs, block.cooldownMs);
		return modelBlockPatch(block.modelFamily, modelId, blockedUntil, current, now, credentialRevision);
	}
	const failureCount = (current?.failureCount ?? 0) + 1;
	// Model blocks belong to the material that earned them, like every other health field.
	const liveModelBlocks =
		current?.credentialRevision === credentialRevision ? pruneModelBlocks(current?.modelBlocks, now) : undefined;
	const base = {
		failureCount,
		...(credentialRevision === undefined ? {} : { credentialRevision }),
		...(current?.lastSuccessAt === undefined ? {} : { lastSuccessAt: current.lastSuccessAt }),
		...(liveModelBlocks === undefined ? {} : { modelBlocks: liveModelBlocks }),
	};
	if (block.reason === "rate_limit") {
		return {
			...base,
			blockedUntil: now + Math.min(policy?.cooldownCapMs ?? block.cooldownMs, block.cooldownMs),
			blockReason: "rate_limit",
		};
	}
	return { ...base, blockReason: block.reason };
}

export type CredentialRotationOptions = {
	sources: RotationSources;
	/** Stable session key keeps a session on its slot; absent, each request distributes. */
	affinityKey?: string;
	/** The requested model: a limit naming its family blocks only that family on the slot (senpi#2555). */
	modelId?: string;
	hasher?: SlotHasher;
	runAttempt: (
		slot: RotationSlot,
	) => AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>;
};

/**
 * In-lane credential rotation for one provider request. Selection follows the
 * HRW order for the affinity key. Rotation and same-slot retry stay transparent
 * while only announcement frames have reached the caller; the first delta bars
 * them, and a failure after it is forwarded as the provider's own terminal
 * event for the session layer to recover from.
 */
export function streamWithCredentialRotation(
	options: CredentialRotationOptions,
): AsyncGenerator<AssistantMessageEvent> {
	const { sources, runAttempt } = options;
	const hasher = options.hasher ?? sha256SlotHasher;
	const affinityKey = options.affinityKey ?? randomUUID();
	const useAffinity = sources.policy?.affinity !== false;
	const now = sources.now ?? Date.now;

	return runCredentialFailover<AssistantMessageEvent, RotationSlot>({
		listSlots: () => listRotationSlots(sources, options.modelId === undefined ? {} : { modelId: options.modelId }),
		select: (candidates) => {
			const pinned = candidates.find((candidate) => candidate.pinned === true);
			if (pinned) return pinned;
			const ordered = useAffinity ? rendezvousOrder(affinityKey, candidates, hasher) : candidates;

			const winner = ordered[0];
			if (!winner) throw new Error("credential rotation selected from an empty candidate set");
			return winner;
		},
		runAttempt,
		isCommittedOutput: isCommittedRotationOutput,
		isStreamStart: isRotationStreamStart,
		errorFromEvent: rotationErrorFromEvent,
		classify: (error, context) =>
			classifyCredentialFailure(error, {
				...context,
				nowMs: now(),
				cooldownBaseMs: sources.policy?.cooldownBaseMs,
				cooldownCapMs: sources.policy?.cooldownCapMs,
			}),
		onSuccess: async (slot) => {
			await sources.repository.mutateSlotState(sources.providerId, slot.lane, slot.name, (current) =>
				current
					? {
							...current,
							lastSuccessAt: now(),
							lease: undefined,
							blockedUntil: undefined,
							blockReason: undefined,
							// Serving one model says nothing about another model's quota:
							// only the blocks on the model that just served are lifted.
							modelBlocks: pruneModelBlocks(current.modelBlocks, now(), options.modelId),
						}
					: undefined,
			);
		},
		persistBlock: async (slot, block) => {
			const revision =
				slot.lane === "env" && slot.envVarName !== undefined && slot.envKey !== undefined
					? await sources.repository.envCredentialRevision(slot.envVarName, slot.envKey)
					: slot.storedRevision;
			await sources.repository.mutateSlotState(sources.providerId, slot.lane, slot.name, (current) =>
				blockPatch(block, current, now(), revision, sources.policy, options.modelId),
			);
		},
		now,
	});
}
