import type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";

export type CursorCliAccountSlot = {
	name: string;
	access: string;
	refresh: string;
	expires: number;
	source: "login" | "import";
	blockedUntil?: number;
	blockReason?: "rate_limit" | "auth_error";
};

export type CursorCliSlotState = Record<string, { blockedUntil?: number; blockReason?: "rate_limit" | "auth_error" }>;

export type CursorCliOauthCredential = OAuthCredential & {
	accounts?: CursorCliAccountSlot[];
	pinned?: string;
	slotState?: CursorCliSlotState;
};

export const SENTINEL_OAUTH_FIELDS = {
	access: "cursor-cli-oauth-managed",
	refresh: "cursor-cli-oauth-managed",
	expires: 4_102_444_800_000,
} as const;

export function emptyCredential(): CursorCliOauthCredential {
	return { type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [] };
}

function storedAccounts(credential: CursorCliOauthCredential): CursorCliAccountSlot[] {
	return credential.accounts ?? [];
}

export function listAccounts(credential: CursorCliOauthCredential): CursorCliAccountSlot[] {
	return [...storedAccounts(credential)];
}

const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertValidAccountName(name: string): void {
	if (!ACCOUNT_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid account name '${name}': use letters, digits, '-' or '_', starting with a letter or digit`,
		);
	}
}

export function addAccount(credential: CursorCliOauthCredential, slot: CursorCliAccountSlot): CursorCliOauthCredential {
	assertValidAccountName(slot.name);
	if (storedAccounts(credential).some((existing) => existing.name === slot.name)) {
		throw new Error(`Account '${slot.name}' already exists`);
	}
	return {
		...credential,
		...SENTINEL_OAUTH_FIELDS,
		accounts: [...storedAccounts(credential), slot],
	};
}

export function removeAccount(credential: CursorCliOauthCredential, name: string): CursorCliOauthCredential {
	const accounts = storedAccounts(credential).filter((slot) => slot.name !== name);
	const next: CursorCliOauthCredential = {
		...credential,
		...SENTINEL_OAUTH_FIELDS,
		accounts,
	};
	if (credential.pinned === name) delete next.pinned;
	return next;
}

export function pinAccount(credential: CursorCliOauthCredential, name: string): CursorCliOauthCredential {
	assertValidAccountName(name);
	return { ...credential, ...SENTINEL_OAUTH_FIELDS, pinned: name };
}

export function assertSentinelInvariant(credential: CursorCliOauthCredential): void {
	if (
		credential.access !== SENTINEL_OAUTH_FIELDS.access ||
		credential.refresh !== SENTINEL_OAUTH_FIELDS.refresh ||
		credential.expires !== SENTINEL_OAUTH_FIELDS.expires
	) {
		throw new Error("top-level OAuth fields must remain sentinel values");
	}
}

export type CursorCliSlotRefresher = (
	refreshToken: string,
	signal: AbortSignal,
) => Promise<{ refresh: string; access: string; expires: number }>;

export async function refreshSlot(
	store: CredentialStore,
	providerId: string,
	slotName: string,
	refresher: CursorCliSlotRefresher,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	return store.modify(providerId, async (current) => {
		if (current?.type !== "oauth") return undefined;
		const credential = current as CursorCliOauthCredential;
		assertSentinelInvariant(credential);
		const slot = storedAccounts(credential).find((candidate) => candidate.name === slotName);
		if (!slot || Date.now() < slot.expires) return current;
		const refreshed = await refresher(slot.refresh, signal);
		const accounts = storedAccounts(credential).map((candidate) =>
			candidate.name === slotName
				? {
						...candidate,
						access: refreshed.access,
						refresh: refreshed.refresh,
						expires: refreshed.expires,
					}
				: candidate,
		);
		return { ...credential, ...SENTINEL_OAUTH_FIELDS, accounts };
	});
}
