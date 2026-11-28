import { envValue } from "./brand.ts";
import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = envValue("TELEMETRY"),
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	// The machine-wide opt-outs (#14920): DO_NOT_TRACK and OMO_DISABLE_TELEMETRY stop the install ping
	// and the provider attribution headers like every other omo sender, whatever the setting says.
	if (isTruthyEnvFlag(env.DO_NOT_TRACK) || isTruthyEnvFlag(env.OMO_DISABLE_TELEMETRY)) {
		return false;
	}
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
