import type { ResolveSettingsOptions, ResolvedSettings, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { loadedClaudeAgentSdk } from "./sdk-boundary.lazy.ts";
import { type AnthropicSubscriptionProviderSettings, resolveSystemPromptMode } from "./settings.ts";

export type ClaudeSettingsEnvResolver = (options: ResolveSettingsOptions) => Promise<ResolvedSettings>;

async function defaultResolveSettings(options: ResolveSettingsOptions): Promise<ResolvedSettings> {
	const sdk = loadedClaudeAgentSdk();
	if (!sdk) {
		throw new Error(
			`Claude Agent SDK was not preloaded before 'resolveSettings'. ` +
				`Await loadClaudeAgentSdk() on the entry path before reaching the SDK boundary.`,
		);
	}
	return sdk.resolveSettings(options);
}

/**
 * Read the effective `env` block Claude Code will apply from the settings files a query loads (senpi#2988 item 4).
 * Uses the SDK's own settings merge engine, so the files, lookup rules and precedence are the CLI's, not a re-read.
 * Returns undefined when no loaded settings file sets an `env` block, or when the merge fails — the caller then pins
 * as if no settings lifetime existed, instead of failing the turn.
 */
export async function resolveClaudeSettingsEnv(
	input: { cwd: string; settingSources: SettingSource[] },
	resolveSettings: ClaudeSettingsEnvResolver = defaultResolveSettings,
): Promise<Readonly<Record<string, string>> | undefined> {
	try {
		const resolved = await resolveSettings({ cwd: input.cwd, settingSources: input.settingSources });
		const env = resolved.effective.env;
		return env !== undefined && Object.keys(env).length > 0 ? env : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The settings env for one stream's queries. An explicit `settingSources` list applies to every lane; otherwise only
 * a preset-append ambient attempt loads user/project settings (the same rule `buildAnthropicSubscriptionQueryOptions`
 * uses), so anything else resolves to nothing and no merge runs.
 */
export async function resolveQuerySettingsEnv(
	cwd: string,
	providerSettings: AnthropicSubscriptionProviderSettings,
): Promise<Readonly<Record<string, string>> | undefined> {
	const settingSources =
		providerSettings.settingSources ??
		(resolveSystemPromptMode(providerSettings).mode === "preset-append" ? ["user", "project"] : []);
	if (settingSources.length === 0) return undefined;
	return resolveClaudeSettingsEnv({ cwd, settingSources });
}
