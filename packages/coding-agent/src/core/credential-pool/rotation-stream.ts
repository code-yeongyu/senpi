import { createHash, randomUUID } from "node:crypto";
import { type AssistantMessageEvent, type Credential, normalizeProviderId } from "@earendil-works/pi-ai";
import { rendezvousOrder, type SlotHasher } from "@earendil-works/pi-ai/auth/pool/select";
import { listSlots as listCredentialSlots, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { resolveConfigValue } from "../resolve-config-value.ts";
import { emitAccountSwitch } from "./account-notices.ts";
import { type CredentialBlock, classifyCredentialFailure } from "./classify.ts";
import { admitCodexQuota, preferredCodexQuotaTier } from "./codex-quota.ts";
import { discoverEnvSlots } from "./env-slots.ts";
import { type RunCredentialFailoverOptions, type RunSlot, runCredentialFailover } from "./failover.ts";
import { isCommittedRotationOutput, isRotationStreamStart, rotationErrorFromEvent } from "./rotation-events.ts";
import { acquireHalfOpenLease, type CredentialSlotRepository, type CredentialSlotState } from "./state-store.ts";

/** The exact hash the claude-sdk-oauth affinity oracle uses, so pools never remap. */
export const sha256SlotHasher: SlotHasher = (input) => createHash("sha256").update(input).digest().readBigUInt64BE(0);

export type RotationLane = "stored" | "env";

export type RotationSlot = RunSlot & {
	lane: RotationLane;
	quotaTier?: 0 | 1;
	quotaUnavailable?: boolean;
	/** Env-lane key material for the attempt; never serialized or persisted. */
	envKey?: string;
	envVarName?: string;
	/** Stored-lane material revision binding sidecar health to the current credential; never serialized. */
	storedRevision?: string;
};

export type RotationSources = {
	providerId: string;
	modelId?: string;
	signal?: AbortSignal;
	sessionId?: string;
	source?: string;
	selectionState?: Map<string, string>;
	getCodexUsage?: (slot: RotationSlot) => Promise<unknown>;
	credential: Credential | undefined;
	env: (name: string) => string | undefined;
	repository: CredentialSlotRepository;
	policy?: {
		affinity?: boolean;
		cooldownBaseMs?: number;
		cooldownCapMs?: number;
		slots?: Record<string, { env?: string; value?: string }>;
	};
	now?: () => number;
};

function overlayState(slot: RotationSlot, state: CredentialSlotState | undefined): RotationSlot {
	if (!state) return slot;
	return {
		...slot,
		...(state.blockedUntil === undefined ? {} : { blockedUntil: state.blockedUntil }),
		...(state.blockReason === undefined ? {} : { blockReason: state.blockReason }),
		...(state.failureCount === undefined ? {} : { failureCount: state.failureCount }),
		...(state.lease === undefined ? {} : { lease: state.lease }),
	};
}

/**
 * Lists the provider's rotation slots with sidecar health overlaid. Stored
 * credentials own the lane when present; env slots participate only when
 * nothing is stored, preserving today's resolution precedence. An env slot's
 * persisted health applies only while its HMAC revision still matches the
 * current env value, so rotating a key in place clears its own stale block.
 */
export async function listRotationSlots(
	sources: RotationSources,
	options: { acquireLeases?: boolean } = {},
): Promise<RotationSlot[]> {
	const acquireLeases = options.acquireLeases !== false;
	const { providerId, credential, env, repository } = sources;
	const policySlots: { name: string; envVarName: string; key: string; source: "env" }[] = [];
	for (const [name, ref] of Object.entries(sources.policy?.slots ?? {})) {
		const envVarName = ref.env ?? `models.json:${name}`;
		const key =
			ref.env !== undefined
				? env(ref.env)
				: ref.value !== undefined
					? await resolveConfigValue(ref.value, {})
					: undefined;
		if (!key) continue;
		policySlots.push({ name, envVarName, key, source: "env" });
	}
	if (credential) {
		const state = await repository.listSlots(providerId, "stored");
		const slots: RotationSlot[] = [];
		for (const slot of listCredentialSlots(credential)) {
			const persisted = state[slot.name];
			const storedRevision = await repository.storedCredentialRevision(providerId, slot.name, {
				key: slot.key,
				access: slot.access,
				refresh: slot.refresh,
			});
			// A block belongs to the material that earned it; a re-login starts clean.
			const applicable = persisted?.credentialRevision === storedRevision ? persisted : undefined;
			if (
				acquireLeases &&
				applicable?.blockedUntil !== undefined &&
				applicable.blockedUntil <= (sources.now ?? Date.now)()
			) {
				const lease = await acquireHalfOpenLease(repository, providerId, "stored", slot.name, {
					now: (sources.now ?? Date.now)(),
				});
				if (!lease) continue;
				const leased = await repository.listSlots(providerId, "stored");
				const leasedState = leased[slot.name];
				slots.push(
					overlayState(
						{
							name: slot.name,
							lane: "stored",
							pinned: (credential as PooledCredential).pinned === slot.name,
							storedRevision,
						},
						leasedState?.credentialRevision === storedRevision ? leasedState : undefined,
					),
				);
				continue;
			}
			slots.push(
				overlayState(
					{
						name: slot.name,
						lane: "stored",
						pinned: (credential as PooledCredential).pinned === slot.name,
						storedRevision,
					},
					applicable,
				),
			);
		}
		if (policySlots.length === 0) return slots;
		const namedSources: RotationSources = {
			...sources,
			credential: undefined,
			policy: { ...sources.policy, slots: {} },
		};
		const namedSlots = await listEnvRotationSlots(namedSources, policySlots, acquireLeases);
		return [...slots, ...namedSlots];
	}
	const envSlots = [...discoverEnvSlots(providerId, env), ...policySlots];
	return listEnvRotationSlots(sources, envSlots, acquireLeases);
}

async function listEnvRotationSlots(
	sources: RotationSources,
	envSlots: readonly { name: string; envVarName: string; key: string }[],
	acquireLeases = true,
): Promise<RotationSlot[]> {
	if (envSlots.length === 0) return [];
	const { providerId, repository } = sources;
	const state = await repository.listSlots(providerId, "env");
	const slots: RotationSlot[] = [];
	for (const slot of envSlots) {
		const persisted = state[slot.name];
		const revision = await repository.envCredentialRevision(slot.envVarName, slot.key);
		let applicable = persisted?.credentialRevision === revision ? persisted : undefined;
		if (
			acquireLeases &&
			applicable?.blockedUntil !== undefined &&
			applicable.blockedUntil <= (sources.now ?? Date.now)()
		) {
			const lease = await acquireHalfOpenLease(repository, providerId, "env", slot.name, {
				now: (sources.now ?? Date.now)(),
			});
			if (!lease) continue;
			const leased = await repository.listSlots(providerId, "env");
			applicable = leased[slot.name];
		}
		slots.push(
			overlayState(
				{
					name: slot.name,
					lane: "env",
					envKey: slot.key,
					envVarName: slot.envVarName,
				},
				applicable,
			),
		);
	}
	return slots;
}

function blockPatch(
	block: CredentialBlock,
	current: CredentialSlotState | undefined,
	now: number,
	credentialRevision?: string,
	policy?: { cooldownBaseMs?: number; cooldownCapMs?: number },
): Omit<CredentialSlotState, "stateVersion"> {
	const failureCount = (current?.failureCount ?? 0) + 1;
	const base = {
		failureCount,
		...(credentialRevision === undefined ? {} : { credentialRevision }),
		...(current?.lastSuccessAt === undefined ? {} : { lastSuccessAt: current.lastSuccessAt }),
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
	return runRotation({
		...options,
		isCommittedOutput: isCommittedRotationOutput,
		isStreamStart: isRotationStreamStart,
		errorFromEvent: rotationErrorFromEvent,
	});
}

/** Non-streaming provider requests share the same admission, health, and notices. */
export async function requestWithCredentialRotation<T>(
	options: Omit<CredentialRotationOptions, "runAttempt"> & { runAttempt: (slot: RotationSlot) => Promise<T> },
): Promise<T> {
	let result: { value: T } | undefined;
	for await (const event of runRotation<{ value: T }>({
		...options,
		runAttempt: async function* (slot) {
			yield { value: await options.runAttempt(slot) };
		},
		isCommittedOutput: () => true,
		isStreamStart: () => false,
	})) {
		result = event;
	}
	if (!result) throw new Error("Credential request completed without a result");
	return result.value;
}

function runRotation<TEvent>(
	options: Omit<CredentialRotationOptions, "runAttempt"> &
		Pick<
			RunCredentialFailoverOptions<TEvent, RotationSlot>,
			"runAttempt" | "isCommittedOutput" | "isStreamStart" | "errorFromEvent"
		>,
): AsyncGenerator<TEvent> {
	const { sources, runAttempt } = options;
	const hasher = options.hasher ?? sha256SlotHasher;
	const affinityKey = options.affinityKey ?? randomUUID();
	const useAffinity = sources.policy?.affinity !== false;
	const now = sources.now ?? Date.now;
	const selectionKey = `${sources.providerId}\0${sources.sessionId ?? affinityKey}`;
	const codexProvider = normalizeProviderId(sources.providerId) === "chatgpt-subscription";
	let previous = sources.selectionState?.get(selectionKey);
	let previousFailure: string | undefined;
	let admitted: RotationSlot[] = [];

	return runCredentialFailover<TEvent, RotationSlot>({
		listSlots: async () => {
			const slots = await listRotationSlots(sources);
			// A different caller's probe lease hides a generation candidate, not
			// its remaining normal quota. Assess the full inventory before filtering.
			const inventory = codexProvider ? await listRotationSlots(sources, { acquireLeases: false }) : slots;
			previous ??=
				inventory.find((slot) => slot.pinned)?.name ??
				(useAffinity ? rendezvousOrder(affinityKey, inventory, hasher) : inventory)[0]?.name;
			admitted = await admitCodexQuota(sources, inventory);
			return admitted.filter((slot) =>
				slots.some((candidate) => candidate.name === slot.name && candidate.lane === slot.lane),
			);
		},
		select: (candidates) => {
			candidates = preferredCodexQuotaTier(candidates);
			const pinned = candidates.find((candidate) => candidate.pinned === true);
			const ordered = useAffinity ? rendezvousOrder(affinityKey, candidates, hasher) : candidates;

			const winner = pinned ?? ordered[0];
			if (!winner) throw new Error("credential rotation selected from an empty candidate set");
			if (codexProvider && previous && previous !== winner.name) {
				const prior = admitted.find((slot) => slot.name === previous);
				const reason =
					previousFailure ??
					(prior?.quotaUnavailable
						? "quota unavailable"
						: prior?.blockReason === "rate_limit"
							? "cooldown"
							: prior?.blockReason === "account_disabled"
								? "quota exhausted"
								: (prior?.blockReason ?? "account selection"));
				emitAccountSwitch({
					type: "account_failover",
					provider: sources.providerId,
					from: previous,
					to: winner.name,
					reason: winner.quotaTier === 1 ? `${reason}; using extra usage` : reason,
					sessionId: sources.sessionId,
					source: sources.source,
				});
			}
			previous = winner.name;
			previousFailure = undefined;
			sources.selectionState?.set(selectionKey, winner.name);
			return winner;
		},
		onRotate: ({ slot, block }) => {
			previous = slot.name;
			previousFailure = block.reason;
		},
		runAttempt,
		isCommittedOutput: options.isCommittedOutput,
		isStreamStart: options.isStreamStart,
		errorFromEvent: options.errorFromEvent,
		classify: (error, context) =>
			classifyCredentialFailure(error, {
				...context,
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
				blockPatch(block, current, now(), revision, sources.policy),
			);
		},
		now,
	});
}
