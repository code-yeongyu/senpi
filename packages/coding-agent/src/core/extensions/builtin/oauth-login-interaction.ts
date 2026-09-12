/**
 * Relay a provider OAuth login (`modelRuntime.login`) onto the extension UI of
 * a slash command such as `/gpt-account add`, mirroring what the `/login`
 * dialog and `modes/rpc/login-prompts.ts` do for their surfaces.
 *
 * Three decisions are not visible from the code alone. The login owns its own
 * `AbortController` rather than borrowing `ctx.signal`: that signal belongs to
 * the active run, so binding a login to it made Esc/steer/timeout on the
 * response kill a browser login the user never acted on (#1542). The login is
 * cancelled only by dismissing one of its own dialogs or by re-issuing the
 * command for the same provider. Every dialog is also bound to the per-prompt
 * `AuthPrompt.signal`, so a manual-code dialog is released without cancelling
 * the login when the provider's local callback server wins the race
 * (`loginOpenAICodex`). `auth_url` opens the browser only in the TUI, because
 * an RPC client renders the notice on its own machine.
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { openBrowser as openPlatformBrowser } from "../../../utils/open-browser.ts";
import type { ExtensionCommandContext } from "../types.ts";

export const LOGIN_CANCELLED_MESSAGE = "Login cancelled";

export interface ExtensionLoginInteractionOptions {
	/** Provider name rendered in notices, e.g. "OpenAI Codex OAuth". */
	readonly providerLabel: string;
	/** Provider id; a later login for the same id cancels this one. */
	readonly providerId?: string | undefined;
	/** Browser launcher for `auth_url` events in the TUI; tests inject a recorder. */
	readonly openBrowser?: ((url: string) => void) | undefined;
}

type LoginCommandContext = Pick<ExtensionCommandContext, "mode" | "ui">;

const pendingLogins = new Map<string, AbortController>();

function cancelledError(): Error {
	return new Error(LOGIN_CANCELLED_MESSAGE);
}

function ownLoginController(providerId: string | undefined): AbortController {
	const controller = new AbortController();
	if (providerId === undefined) return controller;
	pendingLogins.get(providerId)?.abort(cancelledError());
	pendingLogins.set(providerId, controller);
	controller.signal.addEventListener(
		"abort",
		() => {
			if (pendingLogins.get(providerId) === controller) pendingLogins.delete(providerId);
		},
		{ once: true },
	);
	return controller;
}

export function createExtensionLoginInteraction(
	ctx: LoginCommandContext,
	options: ExtensionLoginInteractionOptions,
): AuthInteraction {
	const openBrowser = options.openBrowser ?? openPlatformBrowser;
	const controller = ownLoginController(options.providerId);
	return {
		signal: controller.signal,
		prompt: (prompt) => relayPrompt(ctx, controller, prompt),
		notify: (event) => relayEvent(ctx, event, options.providerLabel, openBrowser),
	};
}

function dialogSignal(loginSignal: AbortSignal, promptSignal: AbortSignal | undefined): AbortSignal {
	return promptSignal ? AbortSignal.any([loginSignal, promptSignal]) : loginSignal;
}

async function relayPrompt(ctx: LoginCommandContext, login: AbortController, prompt: AuthPrompt): Promise<string> {
	const signal = dialogSignal(login.signal, prompt.signal);
	if (signal.aborted) throw cancelledError();
	const answer = await answerPrompt(ctx, prompt, { signal });
	if (signal.aborted) throw cancelledError();
	if (answer === undefined) {
		// The user dismissed the login's own dialog: that is the one cancellation the login owns.
		login.abort(cancelledError());
		throw cancelledError();
	}
	return answer;
}

async function answerPrompt(
	ctx: LoginCommandContext,
	prompt: AuthPrompt,
	dialogOptions: { signal: AbortSignal },
): Promise<string | undefined> {
	switch (prompt.type) {
		case "select": {
			const label = await ctx.ui.select(
				prompt.message,
				prompt.options.map((option) => option.label),
				dialogOptions,
			);
			return prompt.options.find((option) => option.label === label)?.id;
		}
		case "text":
		case "secret":
		case "manual_code":
			return ctx.ui.input(prompt.message, prompt.placeholder, dialogOptions);
	}
}

function relayEvent(
	ctx: LoginCommandContext,
	event: AuthEvent,
	providerLabel: string,
	openBrowser: (url: string) => void,
): void {
	switch (event.type) {
		case "auth_url": {
			if (ctx.mode === "tui") openBrowser(event.url);
			const lines = [`Open this URL to authorize ${providerLabel}:`, event.url];
			if (event.instructions) lines.push(event.instructions);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}
		case "device_code":
			ctx.ui.notify(
				[
					`Open this URL to authorize ${providerLabel}:`,
					event.verificationUri,
					`Enter code: ${event.userCode}`,
				].join("\n"),
				"info",
			);
			return;
		case "info": {
			const links = (event.links ?? []).map((link) => (link.label ? `${link.label}: ${link.url}` : link.url));
			ctx.ui.notify([event.message, ...links].join("\n"), "info");
			return;
		}
		case "progress":
			ctx.ui.notify(event.message, "info");
			return;
	}
}
