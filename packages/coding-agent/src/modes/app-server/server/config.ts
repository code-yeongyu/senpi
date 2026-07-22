import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../config.ts";
import { type Settings, SettingsManager } from "../../../core/settings-manager.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type { JsonValue } from "../protocol/base.ts";
import type {
	ConfigLayer,
	ConfigLayerMetadata,
	ConfigLayerSource,
	ConfigReadParams,
	ConfigReadResponse,
	ConfigRequirementsReadResponse,
} from "../protocol/config.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import type { MethodRegistry } from "../rpc/registry.ts";

export interface RegisterAppServerConfigMethodsOptions {
	readonly agentDir?: string;
	readonly serverCwd?: string;
}

const CONFIG_LAYER_VERSION = "unversioned";

const SETTINGS_MAPPINGS = [
	{ settingsKey: "defaultModel", wireKey: "model" },
	{ settingsKey: "defaultProvider", wireKey: "model_provider" },
	{ settingsKey: "defaultThinkingLevel", wireKey: "model_reasoning_effort" },
] as const;

export function registerAppServerConfigMethods(
	registry: MethodRegistry,
	options: RegisterAppServerConfigMethodsOptions = {},
): void {
	const serverCwd = resolvePath(options.serverCwd ?? process.cwd());
	const agentDir = resolvePath(options.agentDir ?? getAgentDir());

	registry.register("config/read", {
		scope: "global",
		handler: ({ request }) => {
			const params = parseConfigReadParams(request.params);
			const cwd = resolvePath(params.cwd ?? serverCwd, serverCwd, { trim: true });
			return buildConfigReadResponse(
				SettingsManager.create(cwd, agentDir),
				agentDir,
				cwd,
				params.includeLayers === true,
			);
		},
	});

	registry.register("configRequirements/read", {
		scope: "global",
		handler: (): ConfigRequirementsReadResponse => ({ requirements: null }),
	});
}

function buildConfigReadResponse(
	settingsManager: SettingsManager,
	agentDir: string,
	cwd: string,
	includeLayers: boolean,
): ConfigReadResponse {
	const globalSettings = settingsManager.getGlobalSettings();
	const projectSettings = settingsManager.getProjectSettings();
	const userSource = {
		type: "user",
		file: join(agentDir, "settings.json"),
		profile: null,
	} as const satisfies ConfigLayerSource;
	const projectSource = {
		type: "project",
		dotCodexFolder: join(cwd, CONFIG_DIR_NAME),
	} as const satisfies ConfigLayerSource;
	const userMetadata = buildLayerMetadata(userSource);
	const projectMetadata = buildLayerMetadata(projectSource);

	const origins: Record<string, ConfigLayerMetadata> = {};
	for (const mapping of SETTINGS_MAPPINGS) {
		if (readMappedSetting(projectSettings, mapping.settingsKey) !== undefined) {
			origins[mapping.wireKey] = projectMetadata;
		} else if (readMappedSetting(globalSettings, mapping.settingsKey) !== undefined) {
			origins[mapping.wireKey] = userMetadata;
		}
	}

	return {
		config: {
			// Pinned Senpi-to-wire map: default model id -> model; default provider -> model_provider.
			model: settingsManager.getDefaultModel() ?? null,
			model_provider: settingsManager.getDefaultProvider() ?? null,
			// Pinned Senpi permission posture; these are the only fixed values exposed here.
			approval_policy: "never",
			sandbox_mode: "danger-full-access",
			// Pinned Senpi-to-wire map: default thinking level -> model_reasoning_effort.
			model_reasoning_effort: settingsManager.getDefaultThinkingLevel() ?? null,
		},
		origins,
		layers: includeLayers
			? [buildLayer(userSource, globalSettings), buildLayer(projectSource, projectSettings)]
			: null,
	} satisfies ConfigReadResponse;
}

function buildLayerMetadata(source: ConfigLayerSource): ConfigLayerMetadata {
	return { name: source, version: CONFIG_LAYER_VERSION };
}

function buildLayer(source: ConfigLayerSource, settings: Settings): ConfigLayer {
	return {
		name: source,
		version: CONFIG_LAYER_VERSION,
		config: buildMappedSettings(settings),
		disabledReason: null,
	};
}

function buildMappedSettings(settings: Settings): Record<string, JsonValue> {
	const config: Record<string, JsonValue> = {};
	for (const mapping of SETTINGS_MAPPINGS) {
		const value = readMappedSetting(settings, mapping.settingsKey);
		if (value !== undefined) config[mapping.wireKey] = value;
	}
	return config;
}

function readMappedSetting(
	settings: Settings,
	key: (typeof SETTINGS_MAPPINGS)[number]["settingsKey"],
): string | undefined {
	const value = settings[key];
	return typeof value === "string" ? value : undefined;
}

function parseConfigReadParams(value: unknown): ConfigReadParams {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw invalidConfigParams("config/read params must be an object");

	const includeLayers = value.includeLayers;
	if (includeLayers !== undefined && typeof includeLayers !== "boolean") {
		throw invalidConfigParams("config/read includeLayers must be a boolean");
	}
	const cwd = value.cwd;
	if (cwd !== undefined && cwd !== null && typeof cwd !== "string") {
		throw invalidConfigParams("config/read cwd must be a string or null");
	}
	return {
		...(includeLayers === undefined ? {} : { includeLayers }),
		...(cwd === undefined ? {} : { cwd }),
	};
}

function invalidConfigParams(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
