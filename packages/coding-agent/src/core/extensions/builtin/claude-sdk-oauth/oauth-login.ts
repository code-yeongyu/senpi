import type { AuthInteraction, OAuthAuth, OAuthCredentials } from "@earendil-works/pi-ai";
import { loadAnthropicOAuth } from "@earendil-works/pi-ai/oauth";
import {
	type AccountSlot,
	addAccount,
	type ClaudeSdkOauthCredential,
	emptyCredential,
	listAccounts,
	pinAccount,
	removeAccount,
	SENTINEL_OAUTH_FIELDS,
} from "./accounts.ts";

export type OAuthLoginCallbacks = {
	signal?: AbortSignal;
	onAuth?: (event: { url: string }) => void | Promise<void>;
	onPrompt?: (prompt: { message: string; placeholder?: string; signal?: AbortSignal }) => Promise<string>;
	onSelect?: (prompt: { message: string; options: { id: string; label: string }[] }) => Promise<string | undefined>;
	onManualCodeInput?: () => Promise<string>;
	onProgress?: (message: string) => void;
};

export type CurrentCredentialReader = () => Promise<ClaudeSdkOauthCredential | undefined>;

export type OAuthConfigShape = {
	name: string;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
};

export const CLAUDE_SDK_OAUTH_NAME = "Claude SDK OAuth (Claude Pro/Max)";

function toSlot(
	credential: { access: string; refresh: string; expires: number },
	name: string,
	source: AccountSlot["source"],
): AccountSlot {
	return { name, access: credential.access, refresh: credential.refresh, expires: credential.expires, source };
}

async function promptAccountName(callbacks: OAuthLoginCallbacks, existing: AccountSlot[]): Promise<string> {
	if (existing.length === 0) return "default";
	if (!callbacks.onPrompt) return `account-${existing.length + 1}`;
	const answer = (
		await callbacks.onPrompt({
			message: `Name for this account (existing: ${existing.map((slot) => slot.name).join(", ")})`,
			placeholder: `account-${existing.length + 1}`,
		})
	).trim();
	return answer || `account-${existing.length + 1}`;
}

function accountSummary(
	credential: ClaudeSdkOauthCredential,
	readEnv?: (name: string) => string | undefined,
	now = Date.now(),
): string {
	return listAccounts(credential, readEnv)
		.map((slot) => {
			const state: string[] = [];
			if (credential.pinned === slot.name) state.push("pinned");
			if (slot.blockReason === "auth_error") state.push("needs re-login");
			else if (slot.blockedUntil !== undefined && slot.blockedUntil > now) {
				state.push(`blocked ${Math.ceil((slot.blockedUntil - now) / 1000)}s`);
			} else state.push("available");
			return `${slot.name} — ${state.join(", ")}`;
		})
		.join("\n");
}

async function pickAccount(
	callbacks: OAuthLoginCallbacks,
	accounts: AccountSlot[],
	message: string,
): Promise<string | undefined> {
	return callbacks.onSelect?.({
		message,
		options: accounts.map((slot) => ({ id: slot.name, label: slot.name })),
	});
}

function clearPin(credential: ClaudeSdkOauthCredential): ClaudeSdkOauthCredential {
	if (credential.pinned === undefined) return credential;
	const next = { ...credential };
	delete next.pinned;
	return next;
}

function clearAccountBlock(credential: ClaudeSdkOauthCredential, name: string): ClaudeSdkOauthCredential {
	const next: ClaudeSdkOauthCredential = {
		...credential,
		accounts: (credential.accounts ?? []).map((slot) => {
			if (slot.name !== name) return slot;
			const next = { ...slot };
			delete next.blockedUntil;
			delete next.blockReason;
			return next;
		}),
	};
	if (credential.slotState?.[name]) {
		const slotState = { ...credential.slotState };
		delete slotState[name];
		if (Object.keys(slotState).length === 0) delete next.slotState;
		else next.slotState = slotState;
	}
	return next;
}

async function manageExistingAccounts(
	credential: ClaudeSdkOauthCredential,
	callbacks: OAuthLoginCallbacks,
	readEnv?: (name: string) => string | undefined,
): Promise<ClaudeSdkOauthCredential | undefined> {
	const accounts = listAccounts(credential, readEnv);
	const action = await callbacks.onSelect?.({
		message: `Claude accounts\n${accountSummary(credential, readEnv)}`,
		options: [
			{ id: "add", label: "Add an account" },
			{ id: "remove", label: "Log out of one account" },
			{ id: "logout-all", label: "Log out of every stored account" },
			{ id: "pin", label: "Pin an account" },
			{ id: "unpin", label: "Clear the pin" },
			{ id: "unblock", label: "Clear a block" },
		],
	});

	switch (action) {
		case "add":
			return undefined;
		case "remove": {
			const name = await pickAccount(callbacks, credential.accounts ?? [], "Log out of which stored account?");
			return name ? removeAccount(credential, name) : credential;
		}
		case "logout-all": {
			const confirmed = await callbacks.onSelect?.({
				message: `Log out of all ${(credential.accounts ?? []).length} stored Claude account(s)?`,
				options: [
					{ id: "no", label: "Cancel" },
					{ id: "yes", label: "Log out of every account" },
				],
			});
			if (confirmed !== "yes") return credential;
			const cleared = { ...clearPin(credential), accounts: [] };
			delete cleared.slotState;
			return cleared;
		}
		case "pin": {
			const name = await pickAccount(callbacks, accounts, "Pin which account?");
			return name ? pinAccount(credential, name) : credential;
		}
		case "unpin":
			return clearPin(credential);
		case "unblock": {
			const name = await pickAccount(callbacks, accounts, "Clear the block on which account?");
			return name ? clearAccountBlock(credential, name) : credential;
		}
		default:
			return credential;
	}
}

export function createOAuthConfig(deps: {
	readCurrent: CurrentCredentialReader;
	readAnthropicCredential?: () => Promise<{ access: string; refresh: string; expires: number } | undefined>;
	readEnv?: (name: string) => string | undefined;
	loginFlow?: OAuthAuth;
}): OAuthConfigShape {
	return {
		name: CLAUDE_SDK_OAUTH_NAME,

		async login(callbacks) {
			const current = (await deps.readCurrent()) ?? emptyCredential();
			const existing = listAccounts(current, deps.readEnv);
			if (existing.length > 0 && callbacks.onSelect) {
				const managed = await manageExistingAccounts(current, callbacks, deps.readEnv);
				if (managed) return managed;
			}
			if (existing.length === 0 && deps.readAnthropicCredential && callbacks.onPrompt) {
				const imported = await deps.readAnthropicCredential();
				if (imported) {
					const answer = (
						await callbacks.onPrompt({
							message: "An Anthropic OAuth login already exists. Import it instead of a new login? [y/N]",
						})
					)
						.trim()
						.toLowerCase();
					if (answer === "y" || answer === "yes") {
						return addAccount(current, toSlot(imported, "imported-anthropic", "import"));
					}
				}
			}
			const interaction: AuthInteraction = {
				signal: callbacks.signal,
				prompt: async (prompt) => {
					if (prompt.type === "select") return "";
					return callbacks.onPrompt
						? callbacks.onPrompt({
								message: prompt.message,
								placeholder: prompt.placeholder,
								signal: prompt.signal,
							})
						: "";
				},
				notify: (event) => {
					if (event.type === "auth_url" && callbacks.onAuth) void callbacks.onAuth({ url: event.url });
					if (event.type === "progress" && callbacks.onProgress) callbacks.onProgress(event.message);
				},
			};
			const flow = deps.loginFlow ?? (await loadAnthropicOAuth());
			const credential = await flow.login(interaction);

			const existingAfter = listAccounts(current);
			const name = await promptAccountName(callbacks, existingAfter);
			return addAccount(current, toSlot(credential, name, "login"));
		},

		async refreshToken(credentials) {
			return credentials;
		},

		getApiKey(_credentials) {
			return SENTINEL_OAUTH_FIELDS.access;
		},
	};
}
