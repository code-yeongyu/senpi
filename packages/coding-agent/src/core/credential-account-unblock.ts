import { type CredentialSlot, findSlot, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import type { AuthStorage } from "./auth-storage.ts";
import {
	type CredentialAccountBlockedReason,
	credentialPoolRepository,
	getCredentialAccounts,
} from "./credential-accounts.ts";
import { discoverEnvSlots } from "./credential-pool/env-slots.ts";
import type { CredentialSlotRepository, CredentialSlotState } from "./credential-pool/state-store.ts";
import { emitProviderAccountsChanged } from "./extensions/builtin/anthropic-subscription/account-events.ts";

/** Block fields a provider lane may keep on a stored account in auth.json. */
type StoredBlockFields = { blockReason?: unknown; blockedUntil?: unknown; blockedAt?: unknown };

/** What the account looks like after the attempt, not what one source did. */
export type UnblockOutcome = {
	/** A block was actually cleared in at least one health source. */
	readonly lifted: boolean;
	/** Whether the account is still blocked once both sources are merged. */
	readonly blocked: boolean;
	/** Why it is still blocked, when the stored block names a reason. */
	readonly blockedReason?: CredentialAccountBlockedReason;
};

function liftableReason(reason: string | undefined): boolean {
	// Only a timed usage or rate-limit block is the user's to lift: a rejected credential
	// (`auth_error`) and a disabled account are cleared by a login or the re-probe, never here.
	return reason !== "auth_error" && reason !== "account_disabled";
}

/** A sidecar block is the user's to lift only while it is live and belongs to today's material. */
function liftableSidecarBlock(
	state: CredentialSlotState | undefined,
	expectedRevision: string | undefined,
	now: number,
): boolean {
	if (state?.blockedUntil === undefined || state.blockedUntil <= now) return false;
	if (!liftableReason(state.blockReason)) return false;
	// A block belongs to the material that earned it (omo#7084): a block left by a previous login
	// is already ignored by every reader, so lifting it would only rewrite a dead entry.
	return expectedRevision === undefined || state.credentialRevision === expectedRevision;
}

function withoutAccountBlock(state: CredentialSlotState): Omit<CredentialSlotState, "stateVersion"> {
	// Everything that is not the account-level block survives: per-model usage limits
	// (senpi#2555) bind a model the user did not ask about, and a half-open lease belongs to
	// whichever turn is probing right now.
	const {
		stateVersion: _version,
		blockedUntil: _until,
		blockReason: _reason,
		failureCount: _failures,
		...rest
	} = state;
	return rest;
}

function storedSlotWithoutBlock(slot: CredentialSlot & StoredBlockFields): CredentialSlot {
	const { blockedUntil: _until, blockReason: _reason, blockedAt: _at, ...rest } = slot;
	return rest;
}

function storedMaterial(
	storage: AuthStorage,
	provider: string,
	name: string,
): { key?: string; access?: string; refresh?: string } | undefined {
	const credential = storage.get(provider) as PooledCredential | undefined;
	// `findSlot` is what the listing itself reads with, so a flat pre-pool credential resolves to
	// its implicit `default` slot here too; searching `accounts` alone would leave the revision
	// undefined and let a block from a previous login look liftable.
	const slot = findSlot(credential, name);
	if (!slot) return undefined;
	const { key, access, refresh } = slot as CredentialSlot & { key?: string; access?: string; refresh?: string };
	return {
		...(key === undefined ? {} : { key }),
		...(access === undefined ? {} : { access }),
		...(refresh === undefined ? {} : { refresh }),
	};
}

async function expectedRevision(
	repo: CredentialSlotRepository,
	storage: AuthStorage,
	provider: string,
	name: string,
	lane: "stored" | "env",
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	if (lane === "env") {
		const slot = discoverEnvSlots(provider, (key) => env[key]).find((candidate) => candidate.name === name);
		return slot === undefined ? undefined : repo.envCredentialRevision(slot.envVarName, slot.key);
	}
	const material = storedMaterial(storage, provider, name);
	return material === undefined ? undefined : repo.storedCredentialRevision(provider, name, material);
}

/**
 * Lifts the account-level usage or rate-limit block the user knows is gone (senpi#4600).
 *
 * What it clears, in both health sources (the pool sidecar and a block a provider lane stored on
 * the account itself): a live timed block whose reason is not `auth_error` or `account_disabled`,
 * together with the failure counter behind it. Model-scoped limits (senpi#2555), the slot's lease
 * and its success history are left untouched, and an expired block or one left by a previous login
 * is not rewritten. Each decision is retaken inside that source's own locked write, so a block
 * another session records between the listing and the write is never erased, and a source with
 * nothing to lift is not written at all.
 *
 * The outcome is the MERGED state after the attempt: clearing a usage block in one source while
 * the other still holds an auth block leaves the account blocked, and the caller must say so.
 */
export async function unblockPooledAccount(
	storage: AuthStorage,
	provider: string,
	name: string,
	env: NodeJS.ProcessEnv = process.env,
	repository?: CredentialSlotRepository,
): Promise<UnblockOutcome> {
	const repo = repository ?? credentialPoolRepository(storage);
	const accounts = await getCredentialAccounts(storage, provider, env, repo);
	const account = accounts.find((candidate) => candidate.name === name);
	if (!account) throw new Error(`Provider account not found: ${name}`);
	const lane = account.source === "env" ? "env" : "stored";
	const revision = await expectedRevision(repo, storage, provider, name, lane, env);

	let lifted = false;
	try {
		// Nothing liftable in the sidecar: skip the write entirely rather than bump an entry's
		// version or create an empty one. The race the locked re-check guards against can only
		// hide a block, never create a liftable one out of nothing the user asked about.
		if (liftableSidecarBlock((await repo.listSlots(provider, lane))[name], revision, Date.now())) {
			// The callback runs before the document is written, so its decision is only a proposal:
			// `lifted` is promoted once the write has returned, never from inside the callback.
			let clearing = false;
			await repo.mutateSlotState(provider, lane, name, (current) => {
				if (!liftableSidecarBlock(current, revision, Date.now())) {
					clearing = false;
					if (current === undefined) return current;
					const { stateVersion: _version, ...unchanged } = current;
					return unchanged;
				}
				clearing = true;
				return withoutAccountBlock(current as CredentialSlotState);
			});
			lifted = clearing;
		}

		if (storage.get(provider) !== undefined) {
			let clearing = false;
			await storage.modify(provider, async (current) => {
				if (current === undefined) return current;
				const pooled = current as PooledCredential;
				const slots = pooled.accounts;
				if (!Array.isArray(slots)) return current;
				let changed = false;
				const now = Date.now();
				const next = slots.map((slot) => {
					const stored = slot as CredentialSlot & StoredBlockFields;
					if (stored.name !== name) return slot;
					const until = stored.blockedUntil;
					if (typeof until !== "number" || until <= now) return slot;
					if (!liftableReason(stored.blockReason as string | undefined)) return slot;
					changed = true;
					return storedSlotWithoutBlock(stored);
				});
				if (!changed) return current;
				clearing = true;
				return { ...pooled, accounts: next };
			});
			lifted ||= clearing;
		}
	} finally {
		// A lift that already landed is visible to every reader, so the event is owed even when the
		// second write throws: state and the event must not disagree. A write that threw never
		// landed, so it never sets `lifted` and never fires the event.
		if (lifted) emitProviderAccountsChanged(provider);
	}

	const after = await getCredentialAccounts(storage, provider, env, repo);
	const merged = after.find((candidate) => candidate.name === name);
	return {
		lifted,
		blocked: merged?.blocked === true,
		...(merged?.blockedReason === undefined ? {} : { blockedReason: merged.blockedReason }),
	};
}
