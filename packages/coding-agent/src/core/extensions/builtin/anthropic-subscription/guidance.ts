import { ACCOUNT_POOL_REFUSAL_NOTE } from "../../../credential-pool/classify.ts";
import type { PinSource, UnavailableAccount } from "./affinity.ts";
import type { SdkErrorKind } from "./errors.ts";
import type { ClaudeCodeRun } from "./executable.ts";

const PROVIDER = "anthropic-subscription";

export function noAccountGuidance(hasAnthropicCredential: boolean): string {
	const lines = [
		`No Claude account configured for ${PROVIDER}.`,
		`  /login ${PROVIDER}  - sign in with your Claude Pro/Max subscription`,
	];
	if (hasAnthropicCredential) {
		lines.push("  (your existing Anthropic OAuth login will be offered as an import)");
	}
	lines.push(
		"  Or set CLAUDE_CODE_OAUTH_TOKEN (and _2.._N for more accounts),",
		"  or log in with the claude CLI for ambient auth.",
	);
	return lines.join("\n");
}

export function allAccountsBlockedGuidance(soonestUnblockAt: number | undefined, blockReason?: "auth_error"): string {
	if (blockReason === "auth_error") {
		// omo#8383: name the authentication failure; the recovery is a re-login. Only a pool whose every
		// account is auth-blocked says so (senpi#2081), and the outer credential pool reads the refusal note
		// instead of these words, so the verdict is never pinned on whichever outer slot ran the attempt.
		const recheck =
			soonestUnblockAt !== undefined && Number.isFinite(soonestUnblockAt)
				? [`  Next automatic re-check: ${new Date(soonestUnblockAt).toISOString()}.`]
				: [];
		return [
			`All Claude accounts for ${PROVIDER} are currently blocked (authentication error).`,
			...recheck,
			`  /login ${PROVIDER}  - re-authenticate to refresh the blocked account`,
			`  /claude-account list  - inspect account states`,
			ACCOUNT_POOL_REFUSAL_NOTE,
		].join("\n");
	}
	const eta =
		soonestUnblockAt !== undefined && Number.isFinite(soonestUnblockAt)
			? new Date(soonestUnblockAt).toISOString()
			: "after re-login";
	return [
		`All Claude accounts for ${PROVIDER} are currently blocked (rate limit or auth errors).`,
		`  Soonest automatic retry: ${eta}.`,
		`  /claude-account list  - inspect account states`,
		`  /login ${PROVIDER}  - add another account`,
		ACCOUNT_POOL_REFUSAL_NOTE,
	].join("\n");
}

const ENABLE_ACCOUNT_FALLBACK =
	"  Set anthropicSubscriptionProvider.accountFallback: true (or SENPI_CLAUDE_SDK_OAUTH_ACCOUNT_FALLBACK=1) to switch accounts automatically.";

/**
 * How to move off a pinned account. `/claude-account pin` only writes the stored pin, which a CLI or a
 * settings pin outranks (`resolveClaudeAccountPin`), so for those it would change nothing (senpi#3672).
 */
export function switchAccountLine(pinnedBy: PinSource | undefined): string {
	switch (pinnedBy) {
		case "cli":
			return "  This session was started with --claude-account; start a new session with another --claude-account to switch.";
		case "settings":
			return "  The pin comes from anthropicSubscriptionProvider.pinnedAccount (or SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT); change it there to switch accounts.";
		case "stored":
		case undefined:
			return "  /claude-account pin <name>  - switch to another account";
	}
}

/**
 * With account fallback off, only one account may serve (senpi#3465), so the pool-wide advice is wrong:
 * other accounts may be healthy, and adding one does not help because it is never used. Name the account
 * and the remedies that do work. Every variant carries the refusal note, so the outer credential pool
 * fails the request instead of blocking the outer slot it ran on (senpi#2081, senpi#3672).
 */
export function singleAccountUnavailableGuidance(
	account: UnavailableAccount,
	soonestUnblockAt: number | undefined,
	blockReason?: "auth_error",
): string {
	if (!account.configured) {
		return [
			`Claude account '${account.name}' for ${PROVIDER} is not configured, and account fallback is off, so no other account is used.`,
			`  /claude-account list  - see the configured accounts`,
			account.pinnedBy === "cli" || account.pinnedBy === "settings"
				? switchAccountLine(account.pinnedBy)
				: `  /claude-account pin <name>  - pin a configured account (or /claude-account unpin)`,
			"  Start a new session if this session's account was removed.",
			ENABLE_ACCOUNT_FALLBACK,
			ACCOUNT_POOL_REFUSAL_NOTE,
		].join("\n");
	}
	const until =
		soonestUnblockAt !== undefined && Number.isFinite(soonestUnblockAt)
			? new Date(soonestUnblockAt).toISOString()
			: undefined;
	// An auth block's time is only the next re-check: logging in again is what fixes it, as in the pool-wide guidance.
	if (blockReason === "auth_error") {
		return [
			`Claude account '${account.name}' for ${PROVIDER} is blocked (authentication error), and account fallback is off, so no other account is tried.`,
			`  /login ${PROVIDER}  - re-authenticate this account`,
			...(until === undefined ? [] : [`  Next automatic re-check: ${until}.`]),
			switchAccountLine(account.pinnedBy),
			ENABLE_ACCOUNT_FALLBACK,
			ACCOUNT_POOL_REFUSAL_NOTE,
		].join("\n");
	}
	return [
		`Claude account '${account.name}' for ${PROVIDER} is blocked (rate limit)${until === undefined ? "" : ` until ${until}`}, and account fallback is off, so no other account is tried.`,
		...(until === undefined ? [] : [`  Wait until ${until}, when this account can serve again.`]),
		switchAccountLine(account.pinnedBy),
		ENABLE_ACCOUNT_FALLBACK,
		ACCOUNT_POOL_REFUSAL_NOTE,
	].join("\n");
}

/**
 * The remedy for a version-floor 400 depends on which binary ran: updating senpi/omo only helps
 * the bundled one, and `claude update` (which the API text suggests) only helps a `claude` on PATH.
 */
function versionFloorRemedy(target: string, ran: ClaudeCodeRun | undefined): string {
	switch (ran?.source) {
		case "override":
			return `The Claude Code binary set by CLAUDE_CODE_EXECUTABLE (${ran.executable}) is too old for this model. Replace it with ${target}, or unset CLAUDE_CODE_EXECUTABLE to use the Claude Code senpi/omo ships.`;
		case "bundled":
			return `The Claude Code bundled with senpi/omo (${ran.executable}) is too old for this model; \`claude update\` does not change it. Update senpi/omo (it ships a newer @anthropic-ai/claude-agent-sdk), install ${target} as \`claude\` on PATH (a newer one is used automatically), or set CLAUDE_CODE_EXECUTABLE to ${target} binary.`;
		case "path":
			return `The Claude Code on PATH (${ran.executable}) is too old for this model. Run \`claude update\` to get ${target}, or set CLAUDE_CODE_EXECUTABLE to ${target} binary.`;
		case undefined:
			return `The Claude Code binary is too old for this model. Update senpi/omo, update the \`claude\` on PATH, or set CLAUDE_CODE_EXECUTABLE to ${target} binary.`;
	}
}

export function claudeCodeVersionFloorGuidance(text: string, ran?: ClaudeCodeRun): string | undefined {
	const floor = /does not support this model; version (\S+?) or newer is required|claude_code_version_too_old/i.exec(
		text,
	);
	if (floor) {
		const target =
			floor[1] === undefined ? "a newer Claude Code" : `Claude Code ${floor[1].replace(/[.,;:]+$/, "")} or newer`;
		return versionFloorRemedy(target, ran);
	}
	if (/\bmodel_not_found\b|unrecognized_model|not found for provider/i.test(text)) {
		return "The bundled Claude Code binary does not know this model id; update senpi/omo or set CLAUDE_CODE_EXECUTABLE to a newer Claude Code binary.";
	}
	return undefined;
}

export function sdkErrorGuidance(kind: SdkErrorKind): string | undefined {
	switch (kind) {
		case "org_not_allowed":
			return "This organization's policy disallows subscription OAuth use here. Use an API key (ANTHROPIC_API_KEY) or an account from an allowed organization.";
		case "billing":
			return "The selected Claude account has a billing problem. Check the plan at claude.com or switch accounts with /claude-account pin <name>.";
		case "auth_error":
			return `The account's OAuth token was rejected. Re-run /login ${PROVIDER} to refresh it, or remove the account with /claude-account remove <name>.`;
		case "entitlement":
			return "This model needs usage credits on the selected Claude account (it is not included in the subscription). Switch models with /model, enable usage credits at claude.com, or pick another account with /claude-account pin <name>.";
		default:
			return undefined;
	}
}

export function missingBinaryGuidance(platform: string, arch: string): string {
	return [
		`Claude native binary not found for ${platform}-${arch}.`,
		"Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set CLAUDE_CODE_EXECUTABLE.",
	].join("\n");
}

export type SystemPromptMode = "full" | "override" | "preset-append";

export function overrideSystemPromptGuidance(path: string | undefined, reason: string): string {
	const target = path === undefined ? "systemPromptFile" : `systemPromptFile "${path}"`;
	return [
		`Anthropic Subscription override prompt could not load ${target}: ${reason}.`,
		'Set claudeSdkOauthProvider.systemPromptFile to a readable, non-empty UTF-8 prompt file, or select systemPromptMode "full".',
	].join(" ");
}

const armedSessions = new Set<string>();

export function resetPresetAppendDeprecation(sessionId?: string): void {
	if (sessionId !== undefined) {
		armedSessions.delete(sessionId);
	} else {
		armedSessions.clear();
	}
}

export function presetAppendDeprecationGuidance(options: {
	mode: SystemPromptMode;
	conflict?: boolean;
	sessionId: string;
}): string | undefined {
	if (armedSessions.has(options.sessionId)) {
		return undefined;
	}
	const isDeprecated = options.mode === "preset-append";
	if (!options.conflict && !isDeprecated) {
		return undefined;
	}
	armedSessions.add(options.sessionId);
	const parts: string[] = [];
	if (isDeprecated) {
		parts.push(
			"preset-append system-prompt mode is deprecated; " +
				"`full` mode delivers the complete senpi system prompt; " +
				"preset-append will be removed after one release.",
		);
	}
	if (options.conflict) {
		parts.push("systemPromptMode wins.");
	}
	return parts.join(" ");
}
