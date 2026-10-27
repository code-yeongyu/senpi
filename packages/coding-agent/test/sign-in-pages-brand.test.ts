import {
	type OAuthPageBrand,
	oauthErrorHtml,
	oauthSuccessHtml,
	setOAuthPageBrand,
} from "@earendil-works/pi-ai/utils/oauth-page";
import { afterEach, describe, expect, test } from "vitest";
import { LoopbackCallbackServer } from "../src/core/extensions/builtin/mcp/auth/callback.ts";

const HARD_CODED_PRODUCT = /\b(?:senpi|pi)\b|π/i;
const LOGO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

async function mcpCallbackPage(outcome: "success" | "failure"): Promise<string> {
	const server = new LoopbackCallbackServer({ serverName: "fixture", validateState: (state) => state === "good" });
	try {
		const redirectUrl = await server.start();
		const settled = server.waitForCode().then(
			() => "success",
			() => "failure",
		);
		const response = await fetch(`${redirectUrl}?code=abc&state=${outcome === "success" ? "good" : "replayed"}`);
		const html = await response.text();
		expect(response.status).toBe(outcome === "success" ? 200 : 400);
		expect(await settled).toBe(outcome);
		return html;
	} finally {
		await server.close();
	}
}

const pages: ReadonlyArray<{ page: string; render: () => string | Promise<string> }> = [
	{
		page: "provider OAuth success",
		render: () => oauthSuccessHtml("Signed in to Devin. You may now close this page."),
	},
	{ page: "provider OAuth error", render: () => oauthErrorHtml("Devin authorization was denied.", "access_denied") },
	{ page: "MCP callback success", render: () => mcpCallbackPage("success") },
	{ page: "MCP callback failure", render: () => mcpCallbackPage("failure") },
];

const brands: ReadonlyArray<{ brand: string; value: OAuthPageBrand | undefined }> = [
	{ brand: "unset", value: undefined },
	{ brand: "set", value: { name: "Acme Agent", logo: LOGO } },
];

const cases = pages.flatMap((page) => brands.map((brand) => ({ ...page, ...brand })));

describe("sign-in result pages carry the host brand (#4432)", () => {
	afterEach(() => {
		setOAuthPageBrand(undefined);
	});

	test.each(cases)("$page, brand $brand", async ({ render, value }) => {
		setOAuthPageBrand(value);
		const html = await render();

		expect(html).not.toMatch(HARD_CODED_PRODUCT);
		if (value) {
			expect(html).toContain(`<div class="brand-name">${value.name}</div>`);
			expect(html).toContain(`<img class="logo" src="${LOGO}" alt="" />`);
		} else {
			expect(html).not.toContain('class="brand-name"');
			expect(html).not.toContain('class="logo"');
		}
	});
});
