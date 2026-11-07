import type { CredentialStore } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../../config.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import type { AccountSlot, AnthropicSubscriptionCredential, ClaudeCliAccountCheck } from "./accounts.ts";
import { activeBoundary } from "./auth-lane-boundary.ts";
import {
	type ClaudeCliConnectionTestInput,
	connectionTestModel,
	type DefaultModelSelection,
	runClaudeCliConnectionTest,
} from "./claude-cli-connection-test.ts";
import { defaultExecutableDeps, resolveClaudeCodeExecutable } from "./executable.ts";
import { loadAnthropicSubscriptionProviderSettingsFromDisk } from "./settings.ts";

export type ProviderAccountTestErrorCode =
	| "unsupported_provider"
	| "unknown_account"
	| "unsupported_account"
	| "needs_sign_in";

/** A refusal before any turn runs; `message` is the bare code the RPC error carries. */
export class ProviderAccountTestError extends Error {
	readonly code: ProviderAccountTestErrorCode;

	constructor(code: ProviderAccountTestErrorCode) {
		super(code);
		this.name = "ProviderAccountTestError";
		this.code = code;
	}
}

export function claudeCliDefaultModel(cwd: string): DefaultModelSelection {
	const settings = SettingsManager.create(cwd, getAgentDir());
	return { provider: settings.getDefaultProvider(), model: settings.getDefaultModel() };
}

export type ClaudeCliAccountTestInput = {
	readonly provider: string;
	/** Where `check` is read and written: the caller's own store, so its next listing shows the new check. */
	readonly store: CredentialStore;
	readonly name: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly connectionTest?: (input: ClaudeCliConnectionTestInput) => Promise<ClaudeCliAccountCheck>;
};

function subscription(value: unknown): AnthropicSubscriptionCredential | undefined {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "oauth"
		? (value as AnthropicSubscriptionCredential)
		: undefined;
}

function checkedSlot(current: AccountSlot, check: ClaudeCliAccountCheck): AccountSlot {
	return current.store === "claude-cli" ? { ...current, check } : current;
}

/**
 * Re-runs the sign-in connection test (one pinned "Reply with OK" turn, account fallback off) on one stored Claude
 * CLI account and stores its outcome as `check`. The turn is a probe (`queryWithAuthLane` `probe`): it runs on that
 * account even while it is blocked, recovers no other account, and stores or clears no block. It writes `check`,
 * applied to the slot as it is under the lock (blocks other sessions wrote meanwhile stay), plus the slot's `profile`
 * when the CLI reports a changed one (`claudeCliInitializationCheck` in auth-lane.ts, as on every turn). An account
 * that must sign in again is refused before any turn: no test can pass until it signs in.
 */
export async function testClaudeCliAccount(input: ClaudeCliAccountTestInput): Promise<ClaudeCliAccountCheck> {
	if (input.provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER_ID)
		throw new ProviderAccountTestError("unsupported_provider");
	const store = input.store;
	const before = subscription(await store.read(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID))?.accounts?.find(
		(slot) => slot.name === input.name,
	);
	if (before === undefined) throw new ProviderAccountTestError("unknown_account");
	if (before.store !== "claude-cli") throw new ProviderAccountTestError("unsupported_account");
	if (before.signInRequired !== undefined) throw new ProviderAccountTestError("needs_sign_in");

	const env = activeBoundary.env();
	const model = connectionTestModel(claudeCliDefaultModel(input.cwd));
	const check = await (input.connectionTest ?? runClaudeCliConnectionTest)({
		name: input.name,
		model,
		executable: resolveClaudeCodeExecutable({ ...defaultExecutableDeps(), env: (key) => env[key] }),
		cwd: input.cwd,
		providerSettings: loadAnthropicSubscriptionProviderSettingsFromDisk(input.cwd),
		...(input.signal === undefined ? {} : { signal: input.signal }),
		now: activeBoundary.now,
	});
	await store.modify(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, async (stored) => {
		const credential = subscription(stored);
		if (credential === undefined) return stored;
		return {
			...credential,
			accounts: (credential.accounts ?? []).map((slot) =>
				slot.name === input.name ? checkedSlot(slot, check) : slot,
			),
		};
	});
	return check;
}
