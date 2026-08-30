import type { SdkErrorKind } from "./errors.ts";

const PROVIDER = "claude-sdk-oauth";

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

export function allAccountsBlockedGuidance(soonestUnblockAt: number | undefined): string {
	const eta =
		soonestUnblockAt !== undefined && Number.isFinite(soonestUnblockAt)
			? new Date(soonestUnblockAt).toISOString()
			: "after re-login";
	return [
		`All Claude accounts for ${PROVIDER} are currently blocked (rate limit, transient provider, or auth errors).`,
		`  Soonest automatic retry: ${eta}.`,
		`  /claude-account list  - inspect account states`,
		`  /login ${PROVIDER}  - add another account`,
	].join("\n");
}

export function sdkErrorGuidance(kind: SdkErrorKind): string | undefined {
	switch (kind) {
		case "org_not_allowed":
			return "This organization's policy disallows subscription OAuth use here. Use an API key (ANTHROPIC_API_KEY) or an account from an allowed organization.";
		case "billing":
			return "The selected Claude account has a billing problem. Check the plan at claude.com or switch accounts with /claude-account pin <name>.";
		case "auth_error":
			return `The account's OAuth token was rejected. Re-run /login ${PROVIDER} to refresh it, or remove the account with /claude-account remove <name>.`;
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
		`Claude SDK OAuth override prompt could not load ${target}: ${reason}.`,
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
