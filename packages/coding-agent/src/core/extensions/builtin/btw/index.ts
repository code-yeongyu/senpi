import { Editor, Key, type OverlayHandle } from "@earendil-works/pi-tui";
import { getEditorTheme } from "../../../../modes/interactive/theme/theme.ts";
import { convertToLlm, filterContextExcludedMessages } from "../../../messages.ts";
import { buildSessionContext } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../types.ts";
import { sanitizeBtwDisplayText } from "./display-text.ts";
import { BTW_HISTORY_ENTRY_TYPE, buildBtwHistoryMessages, readBtwHistory } from "./history.ts";
import { abortNonTuiSide, type NonTuiSideState, runNonTuiSideCommand, type SideCommandName } from "./non-tui.ts";
import {
	type BtwSideCallbacks,
	BtwSideController,
	type BtwSideControllerOpenOptions,
	type BtwSideSurface,
} from "./side-controller.ts";
import { BTW_SIDE_OVERLAY_OPTIONS, BtwSidePanel } from "./side-panel.ts";
import { buildSideQueryContext, getSideQueryPromptContextWindow, runSideQuery } from "./side-query.ts";

const STATUS_KEY = "btw";
const SIDE_COMMAND_NAMES = ["btw", "side"] as const;
const SIDE_COMMAND_OPTIONS = {
	description: "Ask a side question in parallel without touching the main session",
	argumentHint: "<question>",
};

export default function btwExtension(pi: ExtensionAPI): void {
	const controller = new BtwSideController();
	const nonTuiState: NonTuiSideState = { request: undefined };

	const closeActive = (): void => {
		controller.close();
		abortNonTuiSide(nonTuiState);
	};

	pi.on("session_before_switch", closeActive);
	pi.on("session_before_fork", closeActive);
	pi.on("session_before_tree", closeActive);
	pi.on("session_shutdown", closeActive);
	pi.on("session_extensions_removed", closeActive);
	pi.on("agent_start", () => {
		controller.setParentStatus("working");
	});
	pi.on("agent_end", () => {
		controller.setParentStatus("idle");
	});

	const toggleSide = (ctx: ExtensionContext): void => {
		if (controller.isOpen) controller.toggle();
		else ctx.ui.notify("Use /btw or /side to open a side conversation.", "info");
	};
	const toggleShortcut = {
		description: "Toggle the active BTW side conversation",
		handler: toggleSide,
	};
	pi.registerShortcut(Key.ctrl("_"), toggleShortcut);
	pi.registerShortcut(Key.ctrl("/"), toggleShortcut);

	async function sideHandler(commandName: SideCommandName, args: string, ctx: ExtensionCommandContext): Promise<void> {
		const question = args.trim();
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			await runNonTuiSideCommand(pi, commandName, question, ctx, nonTuiState);
			return;
		}
		const model = ctx.model;
		if (model === undefined) {
			ctx.ui.notify(`No active model available for /${commandName}.`, "error");
			return;
		}
		const snapshot = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
		const history = convertToLlm(filterContextExcludedMessages(snapshot.messages));
		const options: BtwSideControllerOpenOptions = {
			createSurface: (callbacks) => createSurface(ctx, callbacks),
			runQuestion: async ({ question: nextQuestion, signal, onTextDelta }) => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				const context = buildSideQueryContext({
					systemPrompt: ctx.getSystemPrompt(),
					history,
					priorBtw: buildBtwHistoryMessages(readBtwHistory(ctx.sessionManager.getBranch()), model),
					question: nextQuestion,
					promptContextWindow: getSideQueryPromptContextWindow(model),
				});
				const result = await runSideQuery(
					{
						model,
						auth: {
							apiKey: auth.apiKey,
							headers: auth.headers,
							extraBody: auth.extraBody,
						},
						sessionId: ctx.sessionManager.getSessionId(),
						thinkingLevel: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
						streamFn: (streamModel, streamContext, streamOptions) =>
							ctx.modelRegistry.modelRuntime.streamSimple(streamModel, streamContext, streamOptions),
					},
					context,
					{ signal, onTextDelta },
				);
				return result.replyText;
			},
			persist: (entry) => {
				pi.appendEntry(BTW_HISTORY_ENTRY_TYPE, entry);
			},
			notify: (message, type) => {
				ctx.ui.notify(sanitizeBtwDisplayText(message), type);
			},
			setStatus: (text) => {
				ctx.ui.setStatus(STATUS_KEY, text);
			},
			initialParentStatus: ctx.isIdle() ? "idle" : "working",
		};
		await controller.open(options, question.length > 0 ? question : undefined);
	}

	for (const commandName of SIDE_COMMAND_NAMES) {
		pi.registerCommand(commandName, {
			...SIDE_COMMAND_OPTIONS,
			handler: (args, ctx) => sideHandler(commandName, args, ctx),
		});
	}
}

function createSurface(ctx: ExtensionCommandContext, callbacks: BtwSideCallbacks): Promise<BtwSideSurface> {
	return new Promise((resolve, reject) => {
		let panel: BtwSidePanel | undefined;
		let handle: OverlayHandle | undefined;
		let complete: ((result: undefined) => void) | undefined;
		let closed = false;
		let settled = false;

		const close = (): void => {
			if (closed) return;
			closed = true;
			complete?.(undefined);
		};
		const resolveWhenReady = (): void => {
			if (settled || panel === undefined || handle === undefined) return;
			settled = true;
			resolve({ panel, handle, close });
		};

		const lifetime = ctx.ui.custom<undefined>(
			(tui, theme, keybindings, done) => {
				complete = done;
				panel = new BtwSidePanel({
					entries: readBtwHistory(ctx.sessionManager.getBranch()),
					tui,
					theme,
					keybindings,
					callbacks,
					createEditor: () => new Editor(tui, getEditorTheme()),
				});
				resolveWhenReady();
				return panel;
			},
			{
				overlay: true,
				overlayOptions: BTW_SIDE_OVERLAY_OPTIONS,
				onHandle: (nextHandle) => {
					handle = nextHandle;
					resolveWhenReady();
				},
			},
		);
		void lifetime.then(
			() => {
				if (!closed) callbacks.onClose();
			},
			(error: unknown) => {
				if (settled) {
					callbacks.onClose();
					return;
				}
				settled = true;
				reject(error);
			},
		);
	});
}
