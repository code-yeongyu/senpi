import {
	decideTmuxImageCapability,
	parseTmuxKittyTerminalOverride,
	type TmuxKittyTerminalOverride,
} from "./tmux-image-capability.ts";
import { probeTmuxImageState, type TmuxExecFile } from "./tmux-image-probe.ts";

export type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
	tmuxPassthrough?: boolean;
	kittyUnicodePlaceholders?: boolean;
}

export interface DetectedTerminalCapabilities extends TerminalCapabilities {
	cellDimensions?: { widthPx: number; heightPx: number };
}

export function outerKittyGraphicsMode(clientTermname: string): "placeholder" | null {
	const term = clientTermname.trim().toLowerCase();
	return term.includes("kitty") || term.includes("ghostty") || term.includes("warp") ? "placeholder" : null;
}

export function detectTerminalCapabilities(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	execTmux?: TmuxExecFile,
): DetectedTerminalCapabilities {
	const term = env.TERM ?? "";
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	const terminalEmulator = env.TERMINAL_EMULATOR ?? "";
	const colorTerm = env.COLORTERM ?? "";
	const trueColor = colorTerm === "truecolor" || colorTerm === "24bit";

	if (env.TMUX || term.startsWith("tmux")) {
		const state = probeTmuxImageState(env, execTmux);
		const override: TmuxKittyTerminalOverride = parseTmuxKittyTerminalOverride(env.PI_TUI_TMUX_KITTY_TERMINAL);
		const decision = decideTmuxImageCapability(state, override);
		return {
			images: decision.enabled ? "kitty" : null,
			trueColor,
			hyperlinks: state.hyperlinks,
			...(decision.enabled ? { tmuxPassthrough: true } : {}),
			...(decision.enabled && decision.placement === "placeholder" ? { kittyUnicodePlaceholders: true } : {}),
			...(state.cellDimensions ? { cellDimensions: state.cellDimensions } : {}),
		};
	}

	if (env.KITTY_WINDOW_ID) {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}
	if (termProgram === "ghostty") {
		return { images: "kitty", trueColor: true, hyperlinks: true, kittyUnicodePlaceholders: true };
	}
	if (env.WARP_SESSION_ID || env.WARP_TERMINAL_SESSION_UUID || termProgram === "warpterminal") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}
	if (env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true };
	}
	if (termProgram === "iterm.app" || env.ITERM_SESSION_ID) {
		return { images: "iterm2", trueColor: true, hyperlinks: true };
	}
	if (termProgram === "apple_terminal") {
		return { images: null, trueColor: false, hyperlinks: true };
	}
	if (env.WT_SESSION) {
		return { images: null, trueColor: true, hyperlinks: true };
	}
	if (termProgram === "vscode") {
		return { images: null, trueColor: true, hyperlinks: true };
	}
	if (env.CMUX_WORKSPACE_ID || terminalEmulator.includes("JetBrains")) {
		return { images: null, trueColor: true, hyperlinks: false };
	}
	if (term.startsWith("screen")) {
		return { images: null, trueColor, hyperlinks: false };
	}
	// Windows Terminal does not always set WT_SESSION, for example when it hosts
	// a cmd.exe launched directly from Win+R. Modern Windows consoles support
	// truecolor; keep hyperlinks off unless we positively detected support above.
	if (platform === "win32") {
		return { images: null, trueColor: true, hyperlinks: false };
	}
	return {
		images: term === "xterm-kitty" ? "kitty" : null,
		trueColor,
		hyperlinks: false,
	};
}
