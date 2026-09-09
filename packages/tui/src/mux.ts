export function isMultiplexerSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.TMUX || env.TMUX_PANE || env.STY || env.ZELLIJ);
}

export function useLegacyMuxRender(): boolean {
	return process.env.PI_TUI_LEGACY_MUX_RENDER === "1";
}

export function viewportRenderEnabled(): boolean {
	return process.env.PI_TUI_VIEWPORT_RENDER !== "0";
}
