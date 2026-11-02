import type { OAuthCredential } from "@earendil-works/pi-ai";
import { withoutOrderedAccount } from "@earendil-works/pi-ai/auth/pool/select";
import type { ModelBlocks } from "../../../credential-pool/model-scope.ts";

type SlotBlockState = {
	blockedUntil?: number;
	blockReason?: string;
	/** When the current block was stored, so a turn that started earlier never clears it (senpi#3462). */
	blockedAt?: number;
	/** Rate limits that bind one model family on this account, not the account (senpi#2555). */
	modelBlocks?: ModelBlocks;
};

/**
 * A `CLAUDE_CODE_OAUTH_TOKEN[_N]` account. It is never stored: the token is read from the environment for each
 * turn, and the token fields are empty placeholders.
 */
export type EnvAccountSlot = SlotBlockState & {
	/** Immutable operational identity, including SDK session bindings. */
	name: string;
	displayName?: string;
	store?: undefined;
	dirId?: never;
	refresh: string;
	access: string;
	expires: number;
	source: "env";
};

/** The local-only profile `claude auth status` reported; never logged or sent to telemetry. */
export type ClaudeCliAccountProfile = {
	email?: string;
	orgName?: string;
	subscriptionType?: string;
	checkedAt: number;
};

/** The sign-in connection test's last result. */
export type ClaudeCliAccountCheck = {
	model: string;
	outcome: "ok" | "failed";
	reason?: string;
	at: number;
};

/**
 * An account signed in through the bundled `claude` CLI (senpi#4436). It holds no token: the CLI keeps the
 * login in its own credential store, keyed on the account dir `accountDirFor(agentDir, dirId)`.
 */
export type ClaudeCliAccountSlot = SlotBlockState & {
	name: string;
	displayName?: string;
	source: "login";
	store: "claude-cli";
	/** 32 hex chars, fixed at creation. */
	dirId: string;
	signedInAt?: number;
	profile?: ClaudeCliAccountProfile;
	check?: ClaudeCliAccountCheck;
	signInRequired?: "legacy_sign_in_retired";
	/** A CLI slot never holds token material; declared so reads on an `AccountSlot` see `undefined`, not a missing field. */
	access?: never;
	refresh?: never;
	expires?: never;
};

export type AccountSlot = EnvAccountSlot | ClaudeCliAccountSlot;

/** Narrows a slot to an env token account; a claude CLI slot's login lives in the CLI's own store. */
export function isEnvSlot(slot: AccountSlot): slot is EnvAccountSlot {
	return slot.store === undefined;
}

export type SlotState = Record<
	string,
	{ blockedUntil?: number; blockReason?: string; blockedAt?: number; modelBlocks?: ModelBlocks }
>;

export type AnthropicSubscriptionCredential = OAuthCredential & {
	accounts?: AccountSlot[];
	pinned?: string;
	order?: string[];
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
 * Whether a stored slot is listed: only a claude CLI account is. A stored account that still holds tokens (one the
 * retired senpi-owned login wrote, which the load-time sign-out could not rewrite, or a sentinel projection) is never
 * listed, so no turn or usage poll serves or refreshes its token (senpi#4436). Every listing of stored Claude
 * accounts (this lane's, the generic one RPC uses, and the configured check) applies this one rule, so none of them
 * shows or counts an account the others hide. Takes `object`: the generic listing passes raw pool slots.
 */
export function isListedStoredSlot(slot: object): boolean {
	return "store" in slot && slot.store === "claude-cli";
}

/** The listed accounts: every stored claude CLI account (`isListedStoredSlot`), then the env token accounts. */
export function listAccounts(
	credential: AnthropicSubscriptionCredential,
	env?: (name: string) => string | undefined,
): AccountSlot[] {
	const slots: AccountSlot[] = storedSlots(credential).filter(isListedStoredSlot);
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

export function removeAccount(
	credential: AnthropicSubscriptionCredential,
	name: string,
): AnthropicSubscriptionCredential {
	const accounts = storedSlots(credential).filter((slot) => slot.name !== name);
	const next: AnthropicSubscriptionCredential = { ...credential, accounts };
	if (credential.pinned === name) delete next.pinned;
	return withoutOrderedAccount(next, name);
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

export function envSlots(env: (name: string) => string | undefined): EnvAccountSlot[] {
	const slots: EnvAccountSlot[] = [];
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
