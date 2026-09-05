/**
 * Working/idle activity status surfaced to the host terminal.
 *
 * Two channels carry the status, because no single one reaches every terminal:
 *
 * 1. The OSC title (`Terminal.setTitle`, OSC 0 + OSC 2). This is the standard
 *    channel: iTerm2, Ghostty, WezTerm, Windows Terminal and tmux/screen window
 *    names all follow it, and Zed renders it in the terminal breadcrumbs.
 * 2. `process.title`. Zed builds its terminal *tab* label from the foreground
 *    process (`name` + `argv[1..]`) rather than from the OSC title, so the
 *    status token is mirrored into argv to reach the tab label as well.
 *
 * The status token is a fixed, event-driven string rather than an animated
 * spinner: spinners either spam the title stream or render as bells under
 * screen/tmux (openai/codex#17198).
 */

export type AgentActivityStatus = "working" | "idle";

const STATUS_TOKENS: Record<AgentActivityStatus, string> = {
	working: "[working]",
	idle: "[idle]",
};

/**
 * Prefix a terminal title with the activity status token.
 *
 * The token goes first so it survives the aggressive title truncation that tab
 * bars apply (Zed truncates to 25 characters).
 */
export function formatAgentActivityTitle(status: AgentActivityStatus, title: string): string {
	if (status !== "working") {
		// Idle is the resting state: keep the plain title so tabs stay readable and
		// only the actively-working sessions stand out.
		return title;
	}
	const token = STATUS_TOKENS.working;
	if (!title) {
		return token;
	}
	return `${token} ${title}`;
}

/**
 * Build the `process.title` value that mirrors the activity status into argv.
 *
 * Kept short: it is rendered inside an already narrow tab label.
 */
export function formatAgentActivityProcessTitle(status: AgentActivityStatus, appName: string): string {
	return `${appName} ${STATUS_TOKENS[status]}`;
}
