import { agentDirLabel, CONFIG_DIR_NAME } from "../../../../config.ts";
import type { TipDefinition } from "./types.ts";

export const SETTINGS_TIPS = [
	{
		id: "settings-locations",
		bindings: [],
		render: () =>
			`Use /settings for common options; the rest live in settings.json, with ${CONFIG_DIR_NAME}/settings.json overriding per project.`,
	},
	{
		id: "permission-preset",
		bindings: [],
		render: () =>
			'Set permissionPreset to "workspace", "read-only", or "ask" to decide which tool calls need your approval.',
	},
	{
		id: "packages-setting",
		bindings: [],
		render: () => "The packages setting loads skills, extensions, prompts, and themes from an npm or git package.",
	},
	{
		id: "custom-themes",
		bindings: [],
		render: () => `Switch themes from /settings, and drop custom theme files in ${agentDirLabel()}/themes.`,
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
