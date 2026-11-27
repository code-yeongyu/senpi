import type { InlineExtension } from "../core/extensions/types.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { hasTrustRequiringProjectResources } from "../core/trust-manager.ts";
import { type EngineDiagnostic, type EngineError, engineError } from "./result.ts";

/** How a caller that can ask decides project trust when `trust` is omitted: the CLI's prompt and extensions. */
export type ProjectTrustDecider = (
	settingsManager: SettingsManager,
) => Promise<{ readonly trusted: boolean; readonly diagnostics: readonly EngineDiagnostic[] }>;

/**
 * Where a package or resource command runs: the project directory, the agent directory and the built-in
 * extensions. `decideTrust` is the CLI adapter's; the exported functions have none, never read a terminal,
 * and refuse with `trust_required` when the project needs a trust decision the input did not give.
 */
export interface EngineCommandScope {
	readonly cwd: string;
	readonly agentDir: string;
	readonly extensionFactories: readonly InlineExtension[];
	readonly decideTrust?: ProjectTrustDecider;
}

export interface CommandSettings {
	readonly settingsManager: SettingsManager;
	readonly trustDiagnostics: readonly EngineDiagnostic[];
}

/** The project-trust input a command names when it refuses for want of it. */
const TRUST_REQUIRED_MESSAGE =
	"This project has resources that need a trust decision: pass trust: true (--approve) or trust: false (--no-approve).";

/** The settings a one-shot package or resource command reads, with the project trusted as decided. */
export async function openCommandSettings(
	scope: EngineCommandScope,
	trust: boolean | undefined,
): Promise<CommandSettings | EngineError<"trust_required">> {
	const settingsManager = SettingsManager.create(scope.cwd, scope.agentDir, { projectTrusted: false });
	if (trust !== undefined) {
		settingsManager.setProjectTrusted(trust);
		return { settingsManager, trustDiagnostics: [] };
	}
	if (scope.decideTrust !== undefined) {
		const decided = await scope.decideTrust(settingsManager);
		settingsManager.setProjectTrusted(decided.trusted);
		return { settingsManager, trustDiagnostics: decided.diagnostics };
	}
	if (hasTrustRequiringProjectResources(scope.cwd)) {
		return engineError("trust_required", TRUST_REQUIRED_MESSAGE, { details: { input: "trust" } });
	}
	settingsManager.setProjectTrusted(true);
	return { settingsManager, trustDiagnostics: [] };
}

/** Drains the settings manager's load errors as diagnostics, labelled with the command that read them. */
export function settingsDiagnostics(settingsManager: SettingsManager, context: string): EngineDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		kind: "settings",
		context,
		scope,
		message: error.message,
		...(error.stack ? { stack: error.stack } : {}),
	}));
}
