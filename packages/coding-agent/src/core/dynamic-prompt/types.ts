export type PromptSurface = "terminal" | "app" | "chat";

/**
 * `chat` (a chat bridge posting replies to people in a conversation) takes every `app` rule and
 * differs only in having no handoff block; wording tables written for app and terminal look it up here.
 */
export type TerminalOrApp = Exclude<PromptSurface, "chat">;

export function terminalOrApp(surface: PromptSurface): TerminalOrApp {
	return surface === "chat" ? "app" : surface;
}

export interface AvailableTool {
	name: string;
	category: "search" | "session" | "command" | "other";
}
