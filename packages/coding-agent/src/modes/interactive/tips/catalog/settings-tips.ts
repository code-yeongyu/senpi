import type { TipDefinition } from "./types.ts";

export const SETTINGS_TIPS = [
	{
		id: "settings-locations",
		bindings: [],
		render: () =>
			"Use /settings for common options; the rest live in settings.json, with .senpi/settings.json overriding per project.",
	},
	{
		id: "permission-preset",
		bindings: ["app.approval.cycle"],
		render: (keys) =>
			`Press ${keys("app.approval.cycle")} to cycle workspace, read-only, and ask for this session; permissionPreset chooses the starting policy.`,
	},
	{
		id: "packages-setting",
		bindings: [],
		render: () => "The packages setting loads skills, extensions, prompts, and themes from an npm or git package.",
	},
	{
		id: "custom-themes",
		bindings: [],
		render: () => "Switch themes from /settings, and drop custom theme files in ~/.senpi/agent/themes.",
	},
	{
		id: "reload-resources",
		bindings: [],
		render: () =>
			"Use /reload to re-read keybindings, extensions, skills, prompts, themes, and context files without restarting.",
	},
	{
		id: "project-trust",
		bindings: [],
		render: () =>
			"Use /trust to save a trust decision so this project's settings, skills, and extensions load next time.",
	},
	{
		id: "tips-toggle",
		bindings: [],
		render: () => 'Set "tips": false in settings.json to stop showing these tips.',
	},
] satisfies readonly TipDefinition[];
