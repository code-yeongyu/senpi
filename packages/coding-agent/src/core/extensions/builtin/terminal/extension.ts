import { getShellEnv } from "../../../../utils/shell.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isAnthropicBashEnabled } from "../anthropic-bash/index.ts";
import { TerminalManager } from "./manager.ts";
import { TerminalNotifier } from "./notify.ts";
import { TERMINAL_PROMPT_SECTION } from "./prompt.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { loadTerminalSettings, type ResolvedTerminalSettings, TERMINAL_SETTINGS_DEFAULTS } from "./settings.ts";
import { TERMINAL_BASH_TOOL, TERMINAL_COMPANION_TOOLS } from "./shared.ts";
import { createPtyBashTool } from "./tools/bash.ts";
import { createBashInputTool } from "./tools/bash-input.ts";
import { createBashOutputTool } from "./tools/bash-output.ts";
import { createBashResizeTool } from "./tools/bash-resize.ts";
import type { TerminalToolContext } from "./tools/context.ts";
import { createKillBashTool } from "./tools/kill-bash.ts";

interface TerminalExtensionState {
	manager: TerminalManager | null;
	settings: ResolvedTerminalSettings;
	notifier: TerminalNotifier | null;
	ctx: ExtensionContext | undefined;
	shellPath: string | undefined;
	steppedAside: boolean;
	noticeShown: boolean;
}

function buildToolContext(state: TerminalExtensionState): TerminalToolContext {
	const requireManager = (): TerminalManager => {
		// Lazily create a manager so the tool works even when invoked directly (e.g. via the
		// SDK) before `session_start` initializes one. `session_start` replaces it with a
		// settings-configured manager and tears down any earlier one.
		state.manager ??= new TerminalManager({
			maxSessions: state.settings.maxSessions,
			scrollback: state.settings.scrollback,
		});
		return state.manager;
	};
	return {
		get manager() {
			return requireManager();
		},
		get cwd() {
			return state.ctx?.cwd ?? process.cwd();
		},
		get shellPath() {
			return state.shellPath;
		},
		get defaultCols() {
			return state.settings.defaultCols;
		},
		get defaultRows() {
			return state.settings.defaultRows;
		},
		getEnv: () => getShellEnv(),
		onBackgroundExit: (id: string, runtime: TerminalRuntimeSession) => {
			state.notifier?.notifyCompletion(id, runtime);
		},
	};
}

function shouldStepAside(ctx: ExtensionContext | undefined): boolean {
	return isAnthropicBashEnabled() && ctx?.model?.api === "anthropic-messages";
}

/**
 * Keep the tool surface consistent with anthropic-bash. When native Anthropic bash is active,
 * the PTY companions are deactivated so none dangle without a usable persistent `bash` (the
 * function `bash` is stripped + replaced by native bash in the provider payload). Otherwise the
 * PTY `bash` + companions are (re)activated. Re-evaluated on session_start AND model_select.
 */
function syncToolset(pi: ExtensionAPI, state: TerminalExtensionState): void {
	const stepAside = shouldStepAside(state.ctx);
	const active = new Set(pi.getActiveTools());
	if (stepAside) {
		for (const companion of TERMINAL_COMPANION_TOOLS) active.delete(companion);
		if (!state.noticeShown) {
			state.ctx?.ui.notify("native Anthropic bash active — persistent terminal sessions disabled", "info");
			state.noticeShown = true;
		}
	} else {
		active.add(TERMINAL_BASH_TOOL);
		for (const companion of TERMINAL_COMPANION_TOOLS) active.add(companion);
		state.noticeShown = false;
	}
	state.steppedAside = stepAside;
	pi.setActiveTools([...active]);
}

export function registerTerminalExtension(pi: ExtensionAPI): void {
	const state: TerminalExtensionState = {
		manager: null,
		settings: TERMINAL_SETTINGS_DEFAULTS,
		notifier: null,
		ctx: undefined,
		shellPath: undefined,
		steppedAside: false,
		noticeShown: false,
	};
	const toolCtx = buildToolContext(state);

	pi.registerTool(createPtyBashTool(toolCtx));
	pi.registerTool(createBashOutputTool(toolCtx));
	pi.registerTool(createBashInputTool(toolCtx));
	pi.registerTool(createBashResizeTool(toolCtx));
	pi.registerTool(createKillBashTool(toolCtx));

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		const settingsManager = SettingsManager.create(ctx.cwd);
		state.settings = loadTerminalSettings(settingsManager);
		state.shellPath = settingsManager.getShellPath();
		state.notifier = new TerminalNotifier({
			sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
			getContext: () => state.ctx,
			getMode: () => state.settings.notify,
		});
		await state.manager?.teardown();
		state.manager = new TerminalManager({
			maxSessions: state.settings.maxSessions,
			scrollback: state.settings.scrollback,
		});
		syncToolset(pi, state);
	});

	pi.on("model_select", async (event, ctx) => {
		state.ctx = { ...ctx, model: event.model };
		syncToolset(pi, state);
	});

	pi.on("before_agent_start", async (event) => {
		if (state.steppedAside) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${TERMINAL_PROMPT_SECTION}` };
	});

	pi.on("session_shutdown", async () => {
		await state.manager?.teardown();
		state.manager = null;
	});
}

export default registerTerminalExtension;
