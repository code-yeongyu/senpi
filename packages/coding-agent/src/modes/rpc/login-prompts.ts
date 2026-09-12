/**
 * Bridge OAuth login prompts onto the RPC extension UI dialog channel.
 *
 * Providers whose flow needs mid-flow input (a pasted authorization code, an
 * account choice) call `interaction.prompt(...)`, which AuthStorage routes to
 * `onPrompt`/`onSelect`. Over RPC those become `extension_ui_request` dialogs
 * the client answers with `extension_ui_response`.
 *
 * Cancellation has two independent sources and both must release the dialog:
 * the login-wide signal (login_cancel, or the login having settled) and the
 * per-prompt `AuthPrompt.signal` a provider aborts when an out-of-band step
 * wins the race — e.g. `loginAnthropic` racing a manual-code prompt against
 * its local callback server. A released dialog rejects with "Login cancelled",
 * matching the interactive TUI.
 *
 * Only the prompt text, placeholder, and option labels cross the wire; the
 * client's answer is consumed in-process and never echoed back.
 */

import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";

type RpcLoginPromptCallbacks = Pick<OAuthLoginCallbacks, "onPrompt" | "onSelect">;

export function createRpcLoginPromptCallbacks(
	ui: Pick<ExtensionUIContext, "input" | "select">,
	signal: AbortSignal,
): RpcLoginPromptCallbacks {
	const dialogSignalFor = (promptSignal: AbortSignal | undefined): AbortSignal =>
		promptSignal ? AbortSignal.any([signal, promptSignal]) : signal;

	return {
		async onPrompt(prompt) {
			const dialogSignal = dialogSignalFor(prompt.signal);
			if (dialogSignal.aborted) throw new Error("Login cancelled");
			const value = await ui.input(prompt.message, prompt.placeholder, { signal: dialogSignal });
			if (dialogSignal.aborted || value === undefined) throw new Error("Login cancelled");
			return value;
		},

		async onSelect(prompt) {
			const dialogSignal = dialogSignalFor(prompt.signal);
			if (dialogSignal.aborted) throw new Error("Login cancelled");
			const value = await ui.select(
				prompt.message,
				prompt.options.map((option) => option.label),
				{ signal: dialogSignal },
			);
			if (dialogSignal.aborted) throw new Error("Login cancelled");
			if (value === undefined) return undefined;
			return prompt.options.find((option) => option.label === value)?.id;
		},
	};
}
