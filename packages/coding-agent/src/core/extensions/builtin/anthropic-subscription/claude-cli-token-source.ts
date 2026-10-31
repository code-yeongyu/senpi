import type { ClaudeCliAccountProfile } from "./accounts.ts";

/** A `claude-cli` turn whose CLI authenticated from an inherited credential instead of the account's own sign-in. */
export class ClaudeCliTokenSourceLeak extends Error {
	readonly field: "tokenSource" | "apiKeySource" | "apiProvider" | "account";

	constructor(field: "tokenSource" | "apiKeySource" | "apiProvider" | "account") {
		const reported =
			field === "account"
				? "no signed-in account"
				: field === "apiProvider"
					? "an API provider other than first-party claude.ai"
					: `${field} from an inherited environment credential`;
		super(
			`ClaudeCliTokenSourceLeak: the Claude CLI reported ${reported} ` +
				"instead of this account's own sign-in; the turn was refused before it was sent",
		);
		this.name = "ClaudeCliTokenSourceLeak";
		this.field = field;
	}
}

type InitAccount = {
	email?: unknown;
	organization?: unknown;
	subscriptionType?: unknown;
	apiProvider?: unknown;
	tokenSource?: unknown;
	apiKeySource?: unknown;
};

const ENV_VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

function initAccount(initialization: unknown): InitAccount | undefined {
	if (typeof initialization !== "object" || initialization === null) return undefined;
	const account = (initialization as { account?: unknown }).account;
	return typeof account === "object" && account !== null ? (account as InitAccount) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Checks the account the CLI initialized with (`initializationResult().account`). A `tokenSource` that names an
 * environment variable (`CLAUDE_CODE_OAUTH_TOKEN`, ...) or any `apiKeySource` other than `none` means the turn
 * would bill something other than the account's own claude.ai login, so it throws. Like `claude auth status`, only a
 * first-party account counts: no account, or any `apiProvider` other than `firstParty`, throws too. Returns the
 * reported profile.
 */
export function verifyClaudeCliInitialization(initialization: unknown): Omit<ClaudeCliAccountProfile, "checkedAt"> {
	const account = initAccount(initialization);
	if (account === undefined) throw new ClaudeCliTokenSourceLeak("account");
	if (account.apiProvider !== "firstParty") throw new ClaudeCliTokenSourceLeak("apiProvider");
	const tokenSource = text(account.tokenSource);
	if (tokenSource !== undefined && ENV_VARIABLE_NAME.test(tokenSource))
		throw new ClaudeCliTokenSourceLeak("tokenSource");
	const apiKeySource = text(account.apiKeySource);
	if (apiKeySource !== undefined && apiKeySource !== "none") throw new ClaudeCliTokenSourceLeak("apiKeySource");
	const email = text(account.email);
	const orgName = text(account.organization);
	const subscriptionType = text(account.subscriptionType);
	return {
		...(email === undefined ? {} : { email }),
		...(orgName === undefined ? {} : { orgName }),
		...(subscriptionType === undefined ? {} : { subscriptionType }),
	};
}

export function profileChanged(
	current: ClaudeCliAccountProfile | undefined,
	reported: Omit<ClaudeCliAccountProfile, "checkedAt">,
): boolean {
	return (
		current?.email !== reported.email ||
		current?.orgName !== reported.orgName ||
		current?.subscriptionType !== reported.subscriptionType
	);
}
