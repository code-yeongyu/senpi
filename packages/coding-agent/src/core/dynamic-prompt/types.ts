export type PromptSurface = "terminal" | "app" | "chat";

/**
 * `chat` (a chat bridge posting replies to people in a conversation) takes every `app` rule and
 * differs only in having no handoff block; wording tables written for app and terminal look it up here.
 */
export type TerminalOrApp = Exclude<PromptSurface, "chat">;

export function terminalOrApp(surface: PromptSurface): TerminalOrApp {
	return surface === "chat" ? "app" : surface;
}

/**
 * Which wording the shared prompt generators render (senpi#5665): `full` is their text from before the
 * senpi#5335 diet, `diet` the slimmed text. A prompt preset declares it; every other prompt renders `diet`.
 */
export type SharedSections = "full" | "diet";

export interface AvailableTool {
	name: string;
	category: "search" | "session" | "command" | "other";
}
