/**
 * Relay a provider OAuth login (`modelRuntime.login`) onto the extension UI of
 * a slash command such as `/gpt-account add`, mirroring what the `/login`
 * dialog and `modes/rpc/login-prompts.ts` do for their surfaces.
 *
 * Two decisions are not visible from the code alone: every dialog is bound to
 * the per-prompt `AuthPrompt.signal` as well as the command signal, so a
 * manual-code dialog is released when the provider's local callback server
 * wins the race (`loginOpenAICodex`); and `auth_url` opens the browser only in
 * the TUI, because an RPC client renders the notice on its own machine.
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { openBrowser as openPlatformBrowser } from "../../../utils/open-browser.ts";
import type { ExtensionCommandContext } from "../types.ts";

export const LOGIN_CANCELLED_MESSAGE = "Login cancelled";

export interface ExtensionLoginInteractionOptions {
	/** Provider name rendered in notices, e.g. "OpenAI Codex OAuth". */
	readonly providerLabel: string;
	/** Browser launcher for `auth_url` events in the TUI; tests inject a recorder. */
	readonly openBrowser?: ((url: string) => void) | undefined;
}

type LoginCommandContext = Pick<ExtensionCommandContext, "mode" | "signal" | "ui">;

export function createExtensionLoginInteraction(
	ctx: LoginCommandContext,
	options: ExtensionLoginInteractionOptions,
): AuthInteraction {
	const openBrowser = options.openBrowser ?? openPlatformBrowser;
	return {
		signal: ctx.signal,
		prompt: (prompt) => relayPrompt(ctx, prompt),
		notify: (event) => relayEvent(ctx, event, options.providerLabel, openBrowser),
	};
}

function dialogSignal(
	commandSignal: AbortSignal | undefined,
	promptSignal: AbortSignal | undefined,
): AbortSignal | undefined {
	if (commandSignal && promptSignal) return AbortSignal.any([commandSignal, promptSignal]);
	return commandSignal ?? promptSignal;
}

async function relayPrompt(ctx: LoginCommandContext, prompt: AuthPrompt): Promise<string> {
	const signal = dialogSignal(ctx.signal, prompt.signal);
	if (signal?.aborted) throw new Error(LOGIN_CANCELLED_MESSAGE);
	const dialogOptions = signal ? { signal } : undefined;
	const answer = await answerPrompt(ctx, prompt, dialogOptions);
	if (answer === undefined || signal?.aborted) throw new Error(LOGIN_CANCELLED_MESSAGE);
	return answer;
}

async function answerPrompt(
	ctx: LoginCommandContext,
	prompt: AuthPrompt,
	dialogOptions: { signal: AbortSignal } | undefined,
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
