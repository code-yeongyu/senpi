import {
	decideTmuxImageCapability,
	parseTmuxKittyTerminalOverride,
	type TmuxKittyTerminalOverride,
} from "./tmux-image-capability.ts";
import { probeTmuxImageState, type TmuxExecFile } from "./tmux-image-probe.ts";
import { isOldWindowsWezTerm, WEZTERM_WINDOWS_IMAGES_HINT } from "./wezterm-windows-images.ts";

export type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
	tmuxPassthrough?: boolean;
	kittyUnicodePlaceholders?: boolean;
	/** Shown next to the image placeholder when the terminal could show images after a user action. */
	imageHint?: string;
	/** Set when image support is still unknown from the environment: the TUI must query the terminal and record the answer via `setProbedImageProtocol`. */
	imageProbe?: "kitty";
}

export interface DetectedTerminalCapabilities extends TerminalCapabilities {
	cellDimensions?: { widthPx: number; heightPx: number };
}

/**
 * VS Code's integrated terminal normally sets `TERM_PROGRAM=vscode`, but a terminal reached through WSL
 * (or a shell profile that resets it) can arrive with `TERM_PROGRAM` empty (#2826). VS Code sets
 * `VSCODE_IPC_HOOK_CLI` (the `code` CLI's handle) in every integrated terminal, local or remote. Every
 * process started from that terminal inherits it too, including another terminal such as herdr or xterm,
 * so it counts only when `TERM_PROGRAM` is empty: a terminal that sets `TERM_PROGRAM` has claimed the
 * session. Both detectors check this after every other terminal, so a more specific marker wins.
 */
export function isVsCodeTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
	return termProgram === "vscode" || (termProgram === "" && Boolean(env.VSCODE_IPC_HOOK_CLI));
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
	const trueColor = colorTerm === "truecolor" || colorTerm === "24bit" || term.toLowerCase().endsWith("-direct");

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
		return isOldWindowsWezTerm(env.TERM_PROGRAM_VERSION, platform)
			? { images: null, trueColor: true, hyperlinks: true, imageHint: WEZTERM_WINDOWS_IMAGES_HINT }
			: { images: "kitty", trueColor: true, hyperlinks: true };
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
	if (term.startsWith("screen")) {
		return { images: null, trueColor, hyperlinks: false };
	}
	if (env.CMUX_WORKSPACE_ID || terminalEmulator.includes("JetBrains")) {
		return { images: null, trueColor: true, hyperlinks: false };
	}
	if (isVsCodeTerminal(env)) {
		return { images: null, trueColor: true, hyperlinks: true };
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
