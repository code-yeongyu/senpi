import type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";

export type AccountSlot = {
	/** Immutable operational identity, including SDK session bindings. */
	name: string;
	displayName?: string;
	refresh: string;
	access: string;
	expires: number;
	source: "login" | "import" | "env";
	blockedUntil?: number;
	blockReason?: string;
};

export type SlotState = Record<string, { blockedUntil?: number; blockReason?: string }>;

export type AnthropicSubscriptionCredential = OAuthCredential & {
	accounts?: AccountSlot[];
	pinned?: string;
	slotState?: SlotState;
};

export const SENTINEL_OAUTH_FIELDS = {
	access: "claude-sdk-oauth-managed",
	refresh: "claude-sdk-oauth-managed",
	expires: 4102444800000,
} as const;

export function emptyCredential(): AnthropicSubscriptionCredential {
	return { type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [] };
}

function storedSlots(credential: AnthropicSubscriptionCredential): AccountSlot[] {
	return credential.accounts ?? [];
}

/**
 * A stored account whose material is the managed sentinel holds no token at
 * all: it was written by a build that stored this credential's own flat
 * projection as a generated `login-N` slot. Selecting it fails the provider's
 * auth check and dead-ends the request, so it is never listed as an account.
 */
export function isSentinelSlot(slot: Pick<AccountSlot, "access" | "refresh">): boolean {
	return slot.access === SENTINEL_OAUTH_FIELDS.access && slot.refresh === SENTINEL_OAUTH_FIELDS.refresh;
}

export function listAccounts(
	credential: AnthropicSubscriptionCredential,
	env?: (name: string) => string | undefined,
): AccountSlot[] {
	const slots = storedSlots(credential).filter((slot) => !isSentinelSlot(slot));
	if (env) {
		const state = credential.slotState ?? {};
		for (const slot of envSlots(env)) {
			const persisted = state[slot.name];
			slots.push(persisted ? { ...slot, ...persisted } : slot);
		}
	}
	return slots;
}

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidAccountName(name: string): void {
	if (!ACCOUNT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`,
		);
	}
}

export function addAccount(
	credential: AnthropicSubscriptionCredential,
	slot: AccountSlot,
): AnthropicSubscriptionCredential {
	assertValidAccountName(slot.name);
	if (storedSlots(credential).some((existing) => existing.name === slot.name)) {
		throw new Error(`Account '${slot.name}' already exists`);
	}
	return { ...credential, accounts: [...storedSlots(credential), slot] };
}

/**
 * Re-login recovery (omo#7084): a same-name slot is replaced in place — fresh
 * token material and source, block stamps cleared, displayName preserved — so
 * a successful login lifts the slot's `auth_error` lock. Unknown names append.
 */
export function upsertAccount(
	credential: AnthropicSubscriptionCredential,
	slot: AccountSlot,
): AnthropicSubscriptionCredential {
	assertValidAccountName(slot.name);
	const existing = storedSlots(credential).find((candidate) => candidate.name === slot.name);
	if (!existing) return { ...credential, accounts: [...storedSlots(credential), slot] };
	const { blockedUntil: _blockedUntil, blockReason: _blockReason, ...identity } = existing;
	const refreshed: AccountSlot = {
		...identity,
		access: slot.access,
		refresh: slot.refresh,
		expires: slot.expires,
		source: slot.source,
	};
	return {
		...credential,
		accounts: storedSlots(credential).map((candidate) => (candidate.name === slot.name ? refreshed : candidate)),
	};
}

export function removeAccount(
	credential: AnthropicSubscriptionCredential,
	name: string,
): AnthropicSubscriptionCredential {
	const accounts = storedSlots(credential).filter((slot) => slot.name !== name);
	const next: AnthropicSubscriptionCredential = { ...credential, accounts };
	if (credential.pinned === name) delete next.pinned;
	return next;
}

export function pinAccount(credential: AnthropicSubscriptionCredential, name: string): AnthropicSubscriptionCredential {
	return { ...credential, pinned: name };
}

export function assertSentinelInvariant(credential: AnthropicSubscriptionCredential): void {
	if (
		credential.access !== SENTINEL_OAUTH_FIELDS.access ||
		credential.refresh !== SENTINEL_OAUTH_FIELDS.refresh ||
		credential.expires !== SENTINEL_OAUTH_FIELDS.expires
	) {
		throw new Error("top-level OAuth fields must remain sentinel values");
	}
}

export function envSlots(env: (name: string) => string | undefined): AccountSlot[] {
	const slots: AccountSlot[] = [];
	const read = (suffix: string | undefined) =>
		env(suffix === undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${suffix}`);
	const names: Array<{ suffix?: string; slot: string }> = [{ slot: "env" }];
	for (let index = 2; index <= 16; index++) names.push({ suffix: String(index), slot: `env-${index}` });
	for (const { suffix, slot } of names) {
		const token = read(suffix);
		if (token) {
			slots.push({ name: slot, refresh: "", access: "", expires: 0, source: "env" });
		}
	}
	return slots;
}

export function envSlotToken(env: (name: string) => string | undefined, slotName: string): string | undefined {
	const match = /^env(?:-(\d+))?$/.exec(slotName);
	if (!match) return undefined;
	const suffix = match[1];
	return env(suffix === undefined ? "CLAUDE_CODE_OAUTH_TOKEN" : `CLAUDE_CODE_OAUTH_TOKEN_${suffix}`);
}

export type SlotRefresher = (
	refreshToken: string,
	signal: AbortSignal,
) => Promise<{ refresh: string; access: string; expires: number }>;
export type SlotExpirationCheck = (expires: number) => boolean;

export async function refreshSlot(
	store: CredentialStore,
	providerId: string,
	slotName: string,
	refresher: SlotRefresher,
	signal: AbortSignal,
	isExpiring: SlotExpirationCheck = (expires) => Date.now() >= expires,
): Promise<Credential | undefined> {
	return store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return undefined;
		const credential = current as AnthropicSubscriptionCredential;
		const slot = storedSlots(credential).find((candidate) => candidate.name === slotName);
		if (!slot) return current;
		if (!isExpiring(slot.expires)) return current;
		const refreshed = await refresher(slot.refresh, signal);
		const accounts = storedSlots(credential).map((candidate) =>
			candidate.name === slotName
				? { ...candidate, refresh: refreshed.refresh, access: refreshed.access, expires: refreshed.expires }
				: candidate,
		);
		return { ...credential, accounts };
	});
}
