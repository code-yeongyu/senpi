import { describe, expect, it, vi } from "vitest";
import { createExtensionLoginInteraction } from "../../../src/core/extensions/builtin/oauth-login-interaction.ts";
import type { ExtensionCommandContext } from "../../../src/core/extensions/types.ts";

describe("OAuth hinted URL notifications (#5003)", () => {
	it.each(["tui", "rpc"] as const)("does not put ID-token hints in %s notifications", (mode) => {
		const notify = vi.fn();
		const openBrowser = vi.fn();
		const ui = { notify } as unknown as ExtensionCommandContext["ui"];
		const interaction = createExtensionLoginInteraction(
			{ mode, ui },
			{
				providerLabel: "ChatGPT",
				openBrowser,
			},
		);
		const url = "https://auth.openai.com/api/accounts/authorize?client_id=oaiapp_saved&id_token_hint=retained-token";
		interaction.notify({ type: "auth_url", url });
		const message = String(notify.mock.calls[0]?.[0]);
		expect(message).not.toContain("retained-token");
		expect(message).not.toContain("id_token_hint");
		expect(message).toContain("client_id=oaiapp_saved");
		if (mode === "tui") expect(openBrowser).toHaveBeenCalledWith(url);
		else expect(openBrowser).not.toHaveBeenCalled();
	});
});
