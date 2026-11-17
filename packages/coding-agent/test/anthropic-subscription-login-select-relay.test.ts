import { afterEach, describe, expect, it } from "vitest";
import { listAccounts } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	ANTHROPIC_LOGIN_METHOD_PROMPT,
	createOAuthConfig,
} from "../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "./support/fake-claude-cli-login.ts";

afterEach(() => cleanupFakeClaudeCliLogins());

describe("claude-sdk-oauth login relays the method selector", () => {
	it("relays the method select to the client and completes a browser login", async () => {
		const selects: string[] = [];
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const credential = await config.login({
			onSelect: async (prompt) => {
				selects.push(prompt.message);
				return prompt.options[0]?.id;
			},
		});
		expect(selects).toEqual([ANTHROPIC_LOGIN_METHOD_PROMPT.message]);
		const slots = listAccounts(credential as never);
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
	});

	it("a host with no select callback gets the browser login", async () => {
		const config = createOAuthConfig({ readCurrent: async () => undefined, claudeCli: fakeClaudeCliLogin() });
		const credential = await config.login({});
		expect(listAccounts(credential as never).map((slot) => slot.store)).toEqual(["claude-cli"]);
	});
});
