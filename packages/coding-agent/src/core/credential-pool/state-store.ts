import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getAgentDir } from "../../config.ts";
import { CredentialStoreBusyError, FILE_STORAGE_LOCK_RETRY_BUDGET_MS } from "../lockfile-policy.ts";
import { acquireStateFileLock, readStateFile, writeStateFileAtomic } from "./state-file.ts";

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
	// Rate limits that bind one model family on this slot, not the slot (senpi#2555).
	// Absent in files written before; `blockedUntil` keeps meaning "account blocked".
	modelBlocks: z.record(z.string().min(1), z.strictObject({ blockedUntil: z.number().int().positive() })).optional(),
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

function freshDocument(): CredentialPoolStateDocument {
	return { schemaVersion: 1, installationKey: randomBytes(32).toString("hex"), providers: {} };
}

function serialize(document: CredentialPoolStateDocument): string {
	return JSON.stringify(document, null, 2);
}

/** The valid document in `content`, or undefined when it is missing, unreadable or invalid. */
function parseDocument(content: string | undefined): CredentialPoolStateDocument | undefined {
	if (content === undefined) return undefined;
	try {
		const parsed = documentSchema.safeParse(JSON.parse(content));
		return parsed.success ? parsed.data : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export type SlotHealth = "ready" | "blocked" | "half_open";

/** Deadlines are absolute so a restart never re-enables a cooling credential early. */
export function slotHealth(state: CredentialSlotState | undefined, now: number): SlotHealth {
	if (!state) return "ready";
	// A billing block has no expiry; only credential replacement clears it. An auth
	// block lasts until its re-probe time (senpi#3264), like a cooldown.
	if (state.blockReason === "account_disabled") return "blocked";
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
	private readonly lockWaitBudgetMs: number;

	constructor(path: string = credentialPoolStatePath(), options: { readonly lockWaitBudgetMs?: number } = {}) {
		this.path = path;
		this.lockWaitBudgetMs = options.lockWaitBudgetMs ?? FILE_STORAGE_LOCK_RETRY_BUDGET_MS;
	}

	/**
	 * Reads take no lock: writes land by atomic rename, so the file always holds
	 * one complete document. Only a missing or invalid file falls through to the
	 * locked path, which creates or resets it (senpi#3285). When that lock stays
	 * busy too, the read answers with an empty, unsaved document: health is
	 * advisory, and its random installation key matches no stored revision, so
	 * every slot simply reads as healthy for this one request.
	 */
	private async readDocument(): Promise<CredentialPoolStateDocument> {
		const stored = parseDocument(readStateFile(this.path));
		if (stored !== undefined) return stored;
		try {
			return await this.withDocument((document) => ({ result: document }));
		} catch (error) {
			if (error instanceof CredentialStoreBusyError) return freshDocument();
			throw error;
		}
	}

	/**
	 * The sidecar holds only health, so an unreadable or invalid document resets to
	 * a fresh one instead of failing auth resolution; the worst outcome of a reset
	 * is a cleared cooldown, never lost credential material.
	 */
	private async withDocument<T>(
		fn: (document: CredentialPoolStateDocument) => { result: T; next?: CredentialPoolStateDocument },
	): Promise<T> {
		if (!existsSync(this.path)) mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const release = await acquireStateFileLock(this.path, this.lockWaitBudgetMs);
		try {
			const stored = parseDocument(readStateFile(this.path));
			const document = stored ?? freshDocument();
			const { result, next } = fn(document);
			if (next !== undefined || stored === undefined)
				await writeStateFileAtomic(this.path, serialize(next ?? document));
			return result;
		} finally {
			await release();
		}
	}

	async installationKey(): Promise<string> {
		return (await this.readDocument()).installationKey;
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

	/**
	 * The stored-lane twin of the env revision rule: binds a slot's health to
	 * the material that earned it, so a re-login or token refresh replacing the
	 * material retires the block. HMAC over the installation key, never raw
	 * material (omo#7084).
	 */
	async storedCredentialRevision(
		providerId: string,
		slotName: string,
		material: { key?: string; access?: string; refresh?: string },
	): Promise<string> {
		const key = await this.installationKey();
		return createHmac("sha256", key)
			.update(
				`${providerId}\0${slotName}\0${material.key ?? ""}\0${material.access ?? ""}\0${material.refresh ?? ""}`,
			)
			.digest("hex");
	}

	async listSlots(providerId: string, laneId: string): Promise<Record<string, CredentialSlotState>> {
		const document = await this.readDocument();
		return { ...document.providers[providerId]?.lanes[laneId]?.slots };
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
		if (!expired || leaseLive) return current;
		lease = { leaseId: randomUUID(), expiresAt: now + leaseTtlMs };
		return { ...current, lease: { id: lease.leaseId, expiresAt: lease.expiresAt } };
	});
	return lease;
}
