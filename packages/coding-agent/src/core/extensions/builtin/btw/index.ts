import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { convertToLlm, filterContextExcludedMessages } from "../../../messages.ts";
import { buildSessionContext } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { BtwPanel } from "./panel.ts";
import { buildSideQueryContext, getSideQueryPromptContextWindow, runSideQuery } from "./side-query.ts";

const WIDGET_KEY = "btw";

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

	pi.on("session_before_fork", (_event, ctx) => {
		dismiss(ctx, { abort: true });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		dismiss(ctx, { abort: true });
	});

	pi.on("input", (_event, ctx) => {
		if (active?.settled) dismiss(ctx, { abort: false });
	});

	pi.registerCommand("btw", {
		description: "Ask a side question in parallel without touching the main session",
		argumentHint: "<question>",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				// Bare /btw is the explicit off switch: it closes the panel (or cancels an
				// in-flight side query) without interrupting the main turn the way Escape does.
				if (active) {
					dismiss(ctx, { abort: true });
					return;
				}
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
					// matchesKey accepts the raw byte plus kitty CSI-u / modifyOtherKeys encodings.
					// Ignore key releases: kitty CSI-u emits a release event after every press,
					// and this listener runs ahead of the TUI's release filter, so a release
					// whose press was consumed elsewhere would otherwise cancel the query.
					if (active !== entry || isKeyRelease(data) || !matchesKey(data, "escape")) return undefined;
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
