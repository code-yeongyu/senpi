import { convertToLlm, filterContextExcludedMessages } from "../../../messages.ts";
import { buildSessionContext } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { createBtwInputRouter } from "./input-controls.ts";
import { BtwPanel } from "./panel.ts";
import { applyBtwSideSessionPolicy } from "./retained-session.ts";
import {
	closeRetainedBtwSide,
	deleteBtwSessionFile,
	readCurrentBtwSide,
	returnToBtwParent,
} from "./session-actions.ts";
import { buildSideQueryContext, getSideQueryPromptContextWindow, runSideQuery } from "./side-query.ts";
import { defaultBtwTuiCommandDependencies, runBtwTuiCommand } from "./tui-command.ts";

const WIDGET_KEY = "btw";
const ESCAPE = "";

interface ActiveBtw {
	controller: AbortController;
	panel: BtwPanel | undefined;
	unsubscribeEscape: (() => void) | undefined;
	settled: boolean;
}

export default function btwExtension(pi: ExtensionAPI) {
	let active: ActiveBtw | undefined;

	function dismiss(ctx: ExtensionContext, options: { abort: boolean }): void {
		const current = active;
		if (!current) return;
		active = undefined;
		if (options.abort) current.controller.abort();
		current.unsubscribeEscape?.();
		if (current.panel) ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	pi.on("session_before_switch", (_event, ctx) => {
		dismiss(ctx, { abort: true });
	});

	pi.on("session_start", (_event, ctx) => {
		applyBtwSideSessionPolicy(pi, ctx);
		if (ctx.mode !== "tui" || !ctx.ui.matchesKeybinding) return;
		const router = createBtwInputRouter({
			isCurrentSide: () => readCurrentBtwSide(ctx.sessionManager) !== undefined,
			isIdle: () => ctx.isIdle(),
			isDialogActive: () => ctx.ui.isDialogActive?.() ?? false,
			matchesKeybinding: (data, keybinding) => ctx.ui.matchesKeybinding?.(data, keybinding) ?? false,
			dispatch: (command) => {
				pi.sendUserMessage(command, { expandPromptTemplates: true });
			},
		});
		ctx.ui.onTerminalInput((data) => router.handleInput(data));
	});

	pi.on("session_before_fork", (_event, ctx) => {
		dismiss(ctx, { abort: true });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		dismiss(ctx, { abort: true });
	});

	pi.on("input", (_event, ctx) => {
		if (active?.settled) dismiss(ctx, { abort: false });
	});

	pi.registerCommand("btw-main", {
		description: "Return from the current retained BTW session to Main",
		handler: async (_args, ctx) => {
			await returnToBtwParent({
				ctx,
				current: readCurrentBtwSide(ctx.sessionManager),
			});
		},
	});

	pi.registerCommand("btw-close", {
		description: "Delete the current retained BTW session and return to Main",
		handler: async (_args, ctx) => {
			await closeRetainedBtwSide({
				ctx,
				current: readCurrentBtwSide(ctx.sessionManager),
				deleteSessionFile: deleteBtwSessionFile,
			});
		},
	});

	pi.registerCommand("btw", {
		description: "Create or switch retained BTW side sessions",
		argumentHint: "<question>",
		handler: async (args, ctx) => {
			if (ctx.mode === "tui" && ctx.hasUI) {
				dismiss(ctx, { abort: true });
				try {
					await runBtwTuiCommand(args, ctx, defaultBtwTuiCommandDependencies);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`/btw failed: ${message}`, "error");
				}
				return;
			}

			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /btw <question>", "warning");
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model available for /btw.", "error");
				return;
			}

			const snapshot = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			const history = convertToLlm(filterContextExcludedMessages(snapshot.messages));
			const systemPrompt = ctx.getSystemPrompt();
			const thinkingLevel = pi.getThinkingLevel();
			const sessionId = ctx.sessionManager.getSessionId();

			dismiss(ctx, { abort: true });
			const controller = new AbortController();
			const entry: ActiveBtw = { controller, panel: undefined, unsubscribeEscape: undefined, settled: false };
			active = entry;

			if (ctx.mode === "tui" && ctx.hasUI) {
				ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
					const panel = new BtwPanel(question, tui, theme);
					entry.panel = panel;
					return panel.component;
				});
				entry.unsubscribeEscape = ctx.ui.onTerminalInput((data) => {
					if (active !== entry || data !== ESCAPE) return undefined;
					dismiss(ctx, { abort: true });
					return undefined;
				});
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				if (active !== entry) return;
				dismiss(ctx, { abort: false });
				ctx.ui.notify(`/btw: ${auth.error}`, "error");
				return;
			}

			try {
				const context = buildSideQueryContext({
					systemPrompt,
					history,
					question,
					promptContextWindow: getSideQueryPromptContextWindow(model),
				});
				const { replyText } = await runSideQuery(
					{
						model,
						auth: {
							apiKey: auth.apiKey,
							headers: auth.headers,
							extraBody: auth.extraBody,
						},
						sessionId,
						thinkingLevel: thinkingLevel === "off" ? undefined : thinkingLevel,
						streamFn: (streamModel, streamContext, options) =>
							ctx.modelRegistry.modelRuntime.streamSimple(streamModel, streamContext, options),
					},
					context,
					{
						signal: controller.signal,
						onTextDelta: (delta) => {
							if (active === entry) entry.panel?.appendText(delta);
						},
					},
				);
				if (active !== entry) return;
				entry.settled = true;
				if (entry.panel) {
					entry.panel.markDone();
				} else {
					ctx.ui.notify(replyText, "info");
				}
			} catch (error) {
				if (active !== entry) return;
				entry.settled = true;
				const message = error instanceof Error ? error.message : String(error);
				if (controller.signal.aborted) {
					entry.panel?.markAborted();
					return;
				}
				if (entry.panel) {
					entry.panel.markError(message);
				} else {
					ctx.ui.notify(`/btw failed: ${message}`, "error");
				}
			}
		},
	});
}
