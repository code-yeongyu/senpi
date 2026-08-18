import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../../config.ts";
import { AuthStorage } from "../../../auth-storage.ts";
import type { ExtensionAPI, ProviderModelConfig } from "../../types.ts";
import { registerCursorCliAccountCommand } from "./account-command.ts";
import { defaultCursorAgentExecutableDeps, resolveCursorAgentExecutable } from "./executable.ts";
import { resolveCursorCliModelCatalog, STATIC_CURSOR_CLI_MODELS } from "./models.ts";
import { CURSOR_CLI_OAUTH_PROVIDER_ID, createCursorCliOauthConfig } from "./oauth-login.ts";
import { type CursorCliOauthProviderSettings, loadCursorCliOauthProviderSettingsFromDisk } from "./settings.ts";
import { streamCursorCliOauth } from "./stream.ts";

export { CURSOR_CLI_OAUTH_PROVIDER_ID } from "./oauth-login.ts";
export type { CursorCliStreamDeps } from "./stream.ts";

/** Injectable seams; every default resolves real on-disk state. */
export type CursorCliOauthExtensionDeps = {
	readonly cwd?: string;
	readonly agentDir?: string;
	readonly store?: CredentialStore;
	readonly readCurrent?: () => Promise<Credential | undefined>;
	readonly loadSettings?: (cwd: string) => CursorCliOauthProviderSettings;
	readonly resolveExecutable?: (settings: { executablePath?: string }) => string;
};

const defaultResolveExecutable = (settings: { executablePath?: string }): string =>
	resolveCursorAgentExecutable({ ...defaultCursorAgentExecutableDeps(), settings });

/**
 * Registers the cursor-cli-oauth provider lane. Registration is unconditional:
 * the provider ships with the offline model fallback and reports availability
 * through the oauth `check`, so a missing cursor-agent binary never hides the
 * lane - it only makes `check` name the install guidance.
 */
export function registerCursorCliOauthExtension(pi: ExtensionAPI, deps: CursorCliOauthExtensionDeps = {}): void {
	const cwd = deps.cwd ?? process.cwd();
	const agentDir = deps.agentDir ?? getAgentDir();
	const store = deps.store ?? AuthStorage.create();
	const readCurrent = deps.readCurrent ?? (async () => store.read(CURSOR_CLI_OAUTH_PROVIDER_ID));
	const loadSettings = deps.loadSettings ?? loadCursorCliOauthProviderSettingsFromDisk;
	const resolveExecutable = deps.resolveExecutable ?? defaultResolveExecutable;

	// Todo 21: /cursor-account command plus the reload/shutdown teardown for
	// this extension generation (minimal additive wiring).
	registerCursorCliAccountCommand(pi);

	const register = (models: readonly ProviderModelConfig[]): void => {
		pi.registerProvider(CURSOR_CLI_OAUTH_PROVIDER_ID, {
			baseUrl: CURSOR_CLI_OAUTH_PROVIDER_ID,
			api: CURSOR_CLI_OAUTH_PROVIDER_ID,
			models: models.map((entry) => ({ ...entry })),
			// Settings, accounts, and the executable are re-resolved inside every
			// turn; nothing captured here outlives a settings or credential change.
			streamSimple: (model, context, options) =>
				streamCursorCliOauth(model, context, options, { cwd, agentDir, store }),
			oauth: createCursorCliOauthConfig({
				readCurrent,
				readSettings: () => loadSettings(cwd),
				resolveExecutable,
			}),
		});
	};

	// Register immediately with the offline fallback so a missing, hanging, or
	// broken cursor-agent can never delay or block provider registration; the
	// probe-backed catalog replaces it once resolved.
	register(STATIC_CURSOR_CLI_MODELS);
	const settings = loadSettings(cwd);
	void resolveCursorCliModelCatalog({
		agentDir,
		settings: {
			modelCatalogTtlHours: settings.modelCatalogTtlHours,
			executablePath: settings.executablePath,
		},
		deps: { resolveExecutable: () => resolveExecutable({ executablePath: settings.executablePath }) },
	})
		.then((models) => {
			const resolved = models.map((entry) => entry.id).join("\n");
			if (resolved !== STATIC_CURSOR_CLI_MODELS.map((entry) => entry.id).join("\n")) register(models);
		})
		.catch(() => {
			// The loader degrades to the static fallback itself; keep the registered fallback.
		});
}

export default function cursorCliOauthExtension(pi: ExtensionAPI): void {
	registerCursorCliOauthExtension(pi);
}
