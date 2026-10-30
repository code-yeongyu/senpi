import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readByProviderId } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../../../../config.ts";
import { FileAuthStorageBackend } from "../../../auth-storage.ts";
import type { ExtensionAPI, ProviderConfig } from "../../types.ts";
import { toBuiltinProviderContext } from "../provider-context.ts";
import { registerClaudeAccountCommand } from "./account-command.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
import type { AnthropicSubscriptionCredential } from "./accounts.ts";
import { CLAUDE_SDK_OAUTH_API_ID } from "./api-id.ts";
import { plannedContextWindow } from "./context-window.ts";
import { longContextAvailable, onLongContextAvailabilityChange } from "./long-context.ts";
import { createOAuthConfig } from "./oauth-login.ts";
import { registerSessionRegistry } from "./session-registry-wiring.ts";
import { requireAnthropicSubscriptionCwd } from "./session-cwd.ts";
import {
	type AnthropicSubscriptionProviderSettings,
	loadAnthropicSubscriptionProviderSettingsFromDisk,
} from "./settings.ts";
import { streamAnthropicSubscription } from "./stream.ts";

export { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./account-management.ts";
export type AnthropicSubscriptionExtensionDeps = {
	readAmbientAuthStatus?: () => Promise<boolean>;
	/** Overrides the on-disk provider settings the auth predicate consults. */
	readSettings?: () => AnthropicSubscriptionProviderSettings;
};

/**
 * The lane's models carry the window their requests actually get, which is what compaction plans
 * against: the catalog window, except a legacy long-context id at Claude Code's 200k default after the
 * account refused its 1M opt-in (senpi#3408, senpi#3801).
 */
export const anthropicSubscriptionModels = (longContext = longContextAvailable()) =>
	getModels("anthropic").map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: plannedContextWindow(model, longContext),
		maxTokens: model.maxTokens,
		thinkingLevelMap: {
			...model.thinkingLevelMap,
			minimal: null,
		},
	}));

function readStoredCredential(providerId: string): AnthropicSubscriptionCredential | undefined {
	const authPath = join(getAgentDir(), "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, AnthropicSubscriptionCredential>;
		// Read boundary (senpi#1989): this raw read bypasses AuthStorage, so it
		// never sees the auth.json key migration. An auth.json still keyed by the
		// legacy provider id would report the lane logged out with no error at
		// all, so try the canonical key first and then the legacy spelling.
		// `anthropic` is untouched by the rename and still resolves exactly.
		return readByProviderId(data, providerId);
	} catch {
		return undefined;
	}
}

export function registerAnthropicSubscriptionExtension(
	pi: ExtensionAPI,
	deps: AnthropicSubscriptionExtensionDeps = {},
): void {
	const cwd = requireAnthropicSubscriptionCwd(pi.cwd);
	registerClaudeAccountCommand(pi);
	registerSessionRegistry(pi);
	// The lane re-registers whenever the 1M window is refused or offered again, so the session's current
	// model, and compaction with it, plans against the window the requests get. Each registration is the
	// whole config: the runtime validates a registration on its own, not merged with the previous one.
	const providerConfig = (longContext: boolean): ProviderConfig => ({
		baseUrl: CLAUDE_SDK_OAUTH_API_ID,
		api: CLAUDE_SDK_OAUTH_API_ID,
		models: anthropicSubscriptionModels(longContext),
		streamSimple: (model, context, options) =>
			streamAnthropicSubscription(model, toBuiltinProviderContext(context), options),
		// A verbatim `enabled: false` is the kill switch: the lane cannot serve, so
		// it must not consume an implicit fallback-expansion slot. An absent flag
		// stays eligible - an explicit senpi-side login keeps the lane usable.
		fallbackEligible: () => {
			try {
				const settings = deps.readSettings
					? deps.readSettings()
					: loadAnthropicSubscriptionProviderSettingsFromDisk(cwd);
				return settings.enabled !== false;
			} catch {
				return true;
			}
		},
		// The lane selects among its accounts itself (pin, resident account, order, per-account and
		// per-model limits), so the generic credential pool must not choose a second time (senpi#2081).
		ownsAccountSelection: true,
		oauth: createOAuthConfig({
			readCurrent: async () => readStoredCredential(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID),
			readAmbientAuthStatus: deps.readAmbientAuthStatus,
			readSettings: () => {
				try {
					const settings = deps.readSettings
						? deps.readSettings()
						: loadAnthropicSubscriptionProviderSettingsFromDisk(cwd);
					return { tokenInjection: settings.tokenInjection, enabled: settings.enabled };
				} catch {
					return undefined;
				}
			},
			readAnthropicCredential: async () => {
				const credential = readStoredCredential("anthropic");
				return credential && typeof credential.access === "string"
					? { access: credential.access, refresh: credential.refresh, expires: credential.expires }
					: undefined;
			},
			removeAnthropicCredential: async () => {
				// The import is a move, not a copy: one single-use grant must never
				// live in two stores that refresh it independently (omo#7084).
				const backend = new FileAuthStorageBackend();
				await backend.withLockAsync(async (current) => {
					if (current === undefined) return { result: undefined };
					const data = JSON.parse(current) as Record<string, unknown>;
					if (!("anthropic" in data)) return { result: undefined };
					delete data.anthropic;
					return { result: undefined, next: JSON.stringify(data, null, 2) };
				});
			},
		}),
	});
	pi.registerProvider(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, providerConfig(longContextAvailable()));
	const stopFollowingLongContext = onLongContextAvailabilityChange((available) => {
		pi.registerProvider(ANTHROPIC_SUBSCRIPTION_PROVIDER_ID, providerConfig(available));
	});
	pi.on("session_shutdown", () => stopFollowingLongContext());
}

export default function anthropicSubscriptionExtension(pi: ExtensionAPI): void {
	registerAnthropicSubscriptionExtension(pi);
}
