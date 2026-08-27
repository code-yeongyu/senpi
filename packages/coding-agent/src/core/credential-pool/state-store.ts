import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { getAgentDir } from "../../config.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "../lockfile-policy.ts";

export const CREDENTIAL_POOL_STATE_FILENAME = "credential-pool-state.json";

const HEX_256_BIT = /^[0-9a-f]{64}$/;

const leaseSchema = z.strictObject({
	id: z.string().min(1).max(128),
	expiresAt: z.number().int().positive(),
});

const slotStateSchema = z.strictObject({
	stateVersion: z.number().int().nonnegative(),
	blockedUntil: z.number().int().positive().optional(),
	blockReason: z.enum(["auth_error", "rate_limit", "account_disabled"]).optional(),
	failureCount: z.number().int().nonnegative().optional(),
	lastSuccessAt: z.number().int().positive().optional(),
	credentialRevision: z.string().regex(HEX_256_BIT).optional(),
	lease: leaseSchema.optional(),
});

export type CredentialSlotState = Readonly<z.infer<typeof slotStateSchema>>;

const documentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	installationKey: z.string().regex(HEX_256_BIT),
	providers: z.record(
		z.string(),
		z.strictObject({
			lanes: z.record(
				z.string(),
				z.strictObject({
					slots: z.record(z.string(), slotStateSchema),
				}),
			),
		}),
	),
});

export type CredentialPoolStateDocument = z.infer<typeof documentSchema>;

export function credentialPoolStatePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, CREDENTIAL_POOL_STATE_FILENAME);
}

const FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

function freshDocument(): CredentialPoolStateDocument {
	return { schemaVersion: 1, installationKey: randomBytes(32).toString("hex"), providers: {} };
}

/**
 * The sidecar holds only health, so an unreadable or invalid document resets to
 * a fresh one instead of failing auth resolution; the worst outcome of a reset
 * is a cleared cooldown, never lost credential material.
 */
function parseDocument(content: string): CredentialPoolStateDocument {
	try {
		const parsed = documentSchema.safeParse(JSON.parse(content));
		return parsed.success ? parsed.data : freshDocument();
	} catch {
		return freshDocument();
	}
}

export type SlotHealth = "ready" | "blocked" | "half_open";

/** Deadlines are absolute so a restart never re-enables a cooling credential early. */
export function slotHealth(state: CredentialSlotState | undefined, now: number): SlotHealth {
	if (!state) return "ready";
	// Auth and billing blocks have no expiry; only credential replacement clears them.
	if (state.blockReason === "auth_error" || state.blockReason === "account_disabled") return "blocked";
	if (state.blockedUntil !== undefined && state.blockedUntil > now) return "blocked";
	if (state.blockedUntil !== undefined && state.lease !== undefined && state.lease.expiresAt > now) {
		return "half_open";
	}
	return "ready";
}

/**
 * File-locked health sidecar for credential pools. Never stores credential
 * material: env slots are keyed by an installation-local HMAC revision so a
 * rotated env value clears its own stale block without persisting a raw key
 * hash anywhere.
 */
export class CredentialSlotRepository {
	private readonly path: string;

	constructor(path: string = credentialPoolStatePath()) {
		this.path = path;
	}

	private ensureFile(): void {
		if (existsSync(this.path)) return;
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileSync(this.path, JSON.stringify(freshDocument(), null, 2), FILE_WRITE_OPTIONS);
	}

	private async withDocument<T>(
		fn: (document: CredentialPoolStateDocument) => { result: T; next?: CredentialPoolStateDocument },
	): Promise<T> {
		this.ensureFile();
		const release = await lockfile.lock(this.path, FILE_STORAGE_LOCK_OPTIONS);
		try {
			const document = parseDocument(readFileSync(this.path, "utf-8"));
			const { result, next } = fn(document);
			if (next) writeFileSync(this.path, JSON.stringify(next, null, 2), FILE_WRITE_OPTIONS);
			return result;
		} finally {
			await release();
		}
	}

	async installationKey(): Promise<string> {
		return this.withDocument((document) => ({ result: document.installationKey, next: document }));
	}

	/**
	 * Derives the persistence key for an env slot's health. HMAC over the
	 * installation key means the revision is useless outside this installation
	 * and never equals a raw hash of the key material.
	 */
	async envCredentialRevision(envVarName: string, envValue: string): Promise<string> {
		const key = await this.installationKey();
		return createHmac("sha256", key).update(`${envVarName}\0${envValue}`).digest("hex");
	}

	async listSlots(providerId: string, laneId: string): Promise<Record<string, CredentialSlotState>> {
		return this.withDocument((document) => ({
			result: { ...document.providers[providerId]?.lanes[laneId]?.slots },
		}));
	}

	/**
	 * Atomic read-modify-write for one slot's health. `stateVersion` increments
	 * on every write so concurrent mutators can detect lost updates; returning
	 * undefined removes the slot state entirely.
	 */
	async mutateSlotState(
		providerId: string,
		laneId: string,
		slotId: string,
		fn: (current: CredentialSlotState | undefined) => Omit<CredentialSlotState, "stateVersion"> | undefined,
	): Promise<CredentialSlotState | undefined> {
		return this.withDocument((document) => {
			const provider = document.providers[providerId] ?? { lanes: {} };
			const lane = provider.lanes[laneId] ?? { slots: {} };
			const current = lane.slots[slotId];
			const mutated = fn(current);
			const slots = { ...lane.slots };
			let result: CredentialSlotState | undefined;
			if (mutated === undefined) {
				delete slots[slotId];
			} else {
				result = { ...mutated, stateVersion: (current?.stateVersion ?? 0) + 1 };
				slots[slotId] = result;
			}
			const next: CredentialPoolStateDocument = {
				...document,
				providers: {
					...document.providers,
					[providerId]: { lanes: { ...provider.lanes, [laneId]: { slots } } },
				},
			};
			return { result, next };
		});
	}
}

export type HalfOpenLease = { leaseId: string; expiresAt: number };

/**
 * Transitions an expired cooldown atomically to half_open: exactly one caller
 * wins the probe lease; everyone else keeps treating the slot as unavailable
 * until the lease expires or the probe settles the block.
 */
export async function acquireHalfOpenLease(
	repository: CredentialSlotRepository,
	providerId: string,
	laneId: string,
	slotId: string,
	options: { now?: number; leaseTtlMs?: number } = {},
): Promise<HalfOpenLease | undefined> {
	const now = options.now ?? Date.now();
	const leaseTtlMs = options.leaseTtlMs ?? 30_000;
	let lease: HalfOpenLease | undefined;
	await repository.mutateSlotState(providerId, laneId, slotId, (current) => {
		if (!current) return current;
		const expired = current.blockedUntil !== undefined && current.blockedUntil <= now;
		const leaseLive = current.lease !== undefined && current.lease.expiresAt > now;
		if (!expired || leaseLive || current.blockReason === "auth_error") return current;
		lease = { leaseId: randomUUID(), expiresAt: now + leaseTtlMs };
		return { ...current, lease: { id: lease.leaseId, expiresAt: lease.expiresAt } };
	});
	return lease;
}
