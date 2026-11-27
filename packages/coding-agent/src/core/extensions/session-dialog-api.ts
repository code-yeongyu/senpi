import type { ExtensionUIContext, ExtensionUIInputOptions } from "./types.ts";

/** Dialogs addressed to every client attached to the session (`pi.sessionDialog`). */
export type SessionDialogApi = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "editor">;

const toSession = (opts: ExtensionUIInputOptions | undefined): ExtensionUIInputOptions => ({
	...opts,
	audience: "session",
});

export function createSessionDialogApi(currentUI: () => ExtensionUIContext): SessionDialogApi {
	return {
		select: (title, options, opts) => currentUI().select(title, options, toSession(opts)),
		confirm: (title, message, opts) => currentUI().confirm(title, message, toSession(opts)),
		input: (title, placeholder, opts) => currentUI().input(title, placeholder, toSession(opts)),
		editor: (title, prefill, opts) => currentUI().editor(title, prefill, toSession(opts)),
	};
}
