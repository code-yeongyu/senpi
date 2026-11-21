import { getAgentDir } from "../../../../config.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI } from "../../types.ts";
import { type CmdCliExecutableDeps, defaultCmdCliExecutableDeps } from "./executable.ts";
import { resolveCmdCliModels, STATIC_CMD_CLI_MODELS } from "./models.ts";
import { type CmdCliStreamDeps, streamCmdCli } from "./stream.ts";

export const CMD_CLI_PROVIDER_ID = "cmd-cli";
export const CMD_CLI_DISPLAY_NAME = "Command Code CLI";

export interface CmdCliSettings {
	readonly enabled?: boolean;
	readonly executablePath?: string;
	readonly [key: string]: unknown;
}

export type CmdCliExtensionDeps = {
	readonly executableDeps?: CmdCliExecutableDeps;
	readonly streamDeps?: CmdCliStreamDeps;
	readonly isEnabled?: (pi: ExtensionAPI) => boolean;
};

/**
 * Reads cmd-cli configuration from ExtensionAPI settings, safely falling back to
 * SettingsManager when called during extension loading before runtime initialization.
 */
export function readCmdCliSettings(pi: ExtensionAPI): CmdCliSettings | undefined {
	let rawSettings: Record<string, unknown> | undefined;
	try {
		const settings = pi.getSettings();
		if (typeof settings === "object" && settings !== null) {
			rawSettings = settings as Record<string, unknown>;
		}
	} catch {
		// During extension loading, runtime.getSettings throws until Runner.bindCore().
	}

	if (rawSettings) {
		const value = rawSettings.cmdCliProvider;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return value as CmdCliSettings;
		}
		return undefined;
	}

	try {
		const cwd = pi.cwd ?? process.cwd();
		const manager = SettingsManager.create(cwd, getAgentDir());
		const global = manager.getGlobalSettings() as Record<string, unknown>;
		const project = manager.getProjectSettings() as Record<string, unknown>;
		const globalCmd =
			typeof global.cmdCliProvider === "object" &&
			global.cmdCliProvider !== null &&
			!Array.isArray(global.cmdCliProvider)
				? (global.cmdCliProvider as CmdCliSettings)
				: undefined;
		const projectCmd =
			typeof project.cmdCliProvider === "object" &&
			project.cmdCliProvider !== null &&
			!Array.isArray(project.cmdCliProvider)
				? (project.cmdCliProvider as CmdCliSettings)
				: undefined;

		if (!globalCmd && !projectCmd) return undefined;
		return {
			...globalCmd,
			...projectCmd,
		};
	} catch {
		return undefined;
	}
}

/**
 * Checks whether the Command Code CLI provider is explicitly enabled in settings.
 * Disabled by default; a logged-in host cmd must never activate without explicit opt-in (`cmdCliProvider.enabled: true`).
 */
export function isCmdCliProviderEnabled(pi: ExtensionAPI): boolean {
	const settings = readCmdCliSettings(pi);
	return settings?.enabled === true;
}

/**
 * Registers the Command Code CLI provider when explicitly enabled in settings.
 * cmd executes its own tools; senpi does not execute them. Do not pretend otherwise in code or comments.
 */
export function registerCmdCliExtension(pi: ExtensionAPI, deps: CmdCliExtensionDeps = {}): void {
	const enabled = deps.isEnabled ? deps.isEnabled(pi) : isCmdCliProviderEnabled(pi);
	if (!enabled) {
		return;
	}

	const settings = readCmdCliSettings(pi);
	const configuredExecutablePath = deps.executableDeps?.settings?.executablePath ?? settings?.executablePath;

	const baseExecutableDeps = deps.executableDeps ?? defaultCmdCliExecutableDeps();
	const effectiveExecutableDeps: CmdCliExecutableDeps = {
		...baseExecutableDeps,
		settings: {
			...baseExecutableDeps.settings,
			...(configuredExecutablePath !== undefined ? { executablePath: configuredExecutablePath } : {}),
		},
	};

	const effectiveStreamDeps: CmdCliStreamDeps = {
		...deps.streamDeps,
		executableDeps: {
			...effectiveExecutableDeps,
			...deps.streamDeps?.executableDeps,
			settings: {
				...effectiveExecutableDeps.settings,
				...deps.streamDeps?.executableDeps?.settings,
			},
		},
	};

	pi.registerProvider(CMD_CLI_PROVIDER_ID, {
		name: CMD_CLI_DISPLAY_NAME,
		baseUrl: CMD_CLI_PROVIDER_ID,
		apiKey: CMD_CLI_PROVIDER_ID,
		api: CMD_CLI_PROVIDER_ID,
		models: STATIC_CMD_CLI_MODELS,
		refreshModels: async () => {
			return await resolveCmdCliModels({ executableDeps: effectiveExecutableDeps });
		},
		streamSimple: (model, context, options) => {
			return streamCmdCli(model, context, options, effectiveStreamDeps);
		},
	});
}

export default function cmdCliExtension(pi: ExtensionAPI): void {
	registerCmdCliExtension(pi);
}
