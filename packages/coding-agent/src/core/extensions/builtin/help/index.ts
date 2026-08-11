import { APP_NAME } from "../../../../config.ts";
import { buildHelpMarkdown } from "../../../../modes/interactive/help-content.ts";
import type { ExtensionAPI } from "../../types.ts";
import { HELP_OVERLAY_OPTIONS, HelpPanel } from "./panel.ts";

const NON_TUI_HELP = `Interactive /help is available in TUI mode; run ${APP_NAME} --help for CLI usage.`;

export default function helpExtension(pi: ExtensionAPI): void {
	pi.registerCommand("keybindings", {
		description: "Open your keybindings.json in $EDITOR and reload it live",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					`Interactive /keybindings opens your config in $EDITOR and reloads it; run ${APP_NAME} in TUI mode to use it.`,
					"info",
				);
				return;
			}
			// In TUI mode interactive-mode's text dispatch handles /keybindings first.
		},
	});

	pi.registerCommand("help", {
		description: "Show usage, keybindings, and all commands",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(NON_TUI_HELP, "info");
				return;
			}

			const markdown = buildHelpMarkdown({ extensionCommands: pi.getCommands() });
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => new HelpPanel({ markdown, tui, theme, keybindings, done }),
				{ overlay: true, overlayOptions: HELP_OVERLAY_OPTIONS },
			);
		},
	});
}
