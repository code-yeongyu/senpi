export function isMultiplexerSession(): boolean {
	return Boolean(
		process.env.TMUX ||
			process.env.TMUX_PANE ||
			process.env.STY ||
			process.env.ZELLIJ ||
			(process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID),
	);
}

export function useLegacyMuxRender(): boolean {
	return process.env.PI_TUI_LEGACY_MUX_RENDER === "1";
}

export function viewportRenderEnabled(): boolean {
	return process.env.PI_TUI_VIEWPORT_RENDER !== "0";
}
