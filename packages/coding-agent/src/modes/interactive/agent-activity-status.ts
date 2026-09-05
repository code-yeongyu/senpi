/**
 * Working/idle activity status surfaced to the host terminal via the OSC title.
 *
 * The status is a fixed, event-driven token rather than an animated spinner:
 * spinners either spam the title stream or render as bells under screen/tmux
 * (openai/codex#17198).
 *
 * Reach, measured rather than assumed:
 * - Terminals that take their tab/window title from the OSC title show the
 *   token directly.
 * - Zed routes the OSC title to the terminal *breadcrumbs*; its tab label is
 *   built from the foreground process instead, so the token reaches Zed's
 *   breadcrumbs but not its tab. See the Zed note in the PR/QA evidence.
 */

export type AgentActivityStatus = "working" | "idle";

const WORKING_TOKEN = "[working]";

/**
 * Prefix a terminal title with the activity status token.
 *
 * Idle is the resting state and renders the plain title, so only actively
 * working sessions stand out. The token leads the string so it survives the
 * truncation tab bars apply.
 */
export function formatAgentActivityTitle(status: AgentActivityStatus, title: string): string {
	if (status !== "working") {
		return title;
	}
	if (!title) {
		return WORKING_TOKEN;
	}
	return `${WORKING_TOKEN} ${title}`;
}
