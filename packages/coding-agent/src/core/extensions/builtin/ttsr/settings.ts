export type TtsrDisabledBy = "flag" | "settings";

export interface ResolvedTtsrConfig {
	readonly disabledBy: TtsrDisabledBy | null;
	readonly disabledRules: readonly string[];
}

function ruleList(raw: unknown): string[] {
	if (typeof raw === "string") return raw.split(",").map((name) => name.trim());
	if (Array.isArray(raw))
		return raw.filter((name): name is string => typeof name === "string").map((name) => name.trim());
	return [];
}

function settingsSection(settings: unknown): Readonly<Record<string, unknown>> {
	if (typeof settings !== "object" || settings === null || !("ttsr" in settings)) return {};
	const section: unknown = settings.ttsr;
	return typeof section === "object" && section !== null ? { ...section } : {};
}

/**
 * The `--ttsr-disabled` / `--ttsr-rules-disabled` flags and the `ttsr` settings section (settings.json, global or
 * project). Hosts that start the runtime with fixed arguments, like the desktop app, can only use the setting
 * (senpi#4621). Settings files are not validated, so the section is read defensively. Either source turns a rule off.
 */
export function resolveTtsrConfig(
	flagDisabled: boolean | string | undefined,
	flagRules: boolean | string | undefined,
	settings: unknown,
): ResolvedTtsrConfig {
	const section = settingsSection(settings);
	const disabledBy: TtsrDisabledBy | null =
		flagDisabled === true ? "flag" : section.enabled === false ? "settings" : null;
	const names = [...ruleList(flagRules), ...ruleList(section.disabledRules)].filter((name) => name.length > 0);
	return { disabledBy, disabledRules: [...new Set(names)] };
}
