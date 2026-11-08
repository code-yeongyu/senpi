import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { createHeadlessProjectTrustContext } from "./project-trust-headless.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
}): ProjectTrustContext {
	const headless = createHeadlessProjectTrustContext(options);
	if (!options.hasUI || options.mode !== "interactive") {
		return headless;
	}
	return {
		...headless,
		ui: {
			...headless.ui,
			select: async (title, selectOptions) =>
				showStartupSelector(
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
				),
			confirm: async (title, message) =>
				(await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
					{ label: "Yes", value: true },
					{ label: "No", value: false },
				])) ?? false,
			input: async (title, placeholder) => showStartupInput(options.settingsManager, title, placeholder),
		},
	};
}
