import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";

import { createTwoLineFooterFactory } from "./two-line-footer.ts";

export default function (pi: ExtensionAPI) {
	let enabled = false;

	const toggleFooter = (ctx: ExtensionContext, showNotification: boolean): void => {
		enabled = !enabled;

		if (!enabled) {
			ctx.ui.setFooter(undefined);
			if (showNotification) {
				ctx.ui.notify("Default footer restored", "info");
			}
			return;
		}

		ctx.ui.setFooter(createTwoLineFooterFactory(ctx));
		if (showNotification) {
			ctx.ui.notify("Two-line footer enabled", "info");
		}
	};

	pi.registerCommand("footer", {
		description: "Toggle two-line footer",
		handler: async (_args, ctx) => {
			toggleFooter(ctx, true);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		enabled = false;
		toggleFooter(ctx, false);
	});
}
