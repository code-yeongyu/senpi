import { afterEach, describe, expect, test } from "vitest";
import { type OAuthPageBrand, oauthErrorHtml, oauthSuccessHtml, setOAuthPageBrand } from "../src/utils/oauth-page.ts";

// Path data and colors of the inherited upstream pi mark; none of them may ever reach the page.
const PI_LOGO_FRAGMENTS = ["M165.29 165.29H517.36", "#F09082", "#4D9ABF", "#F1BE58"];

const LOGO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

const pages = [
	{
		page: "success",
		render: () => oauthSuccessHtml("Anthropic authentication completed. You can close this window."),
	},
	{
		page: "error",
		render: () => oauthErrorHtml("Anthropic authentication did not complete.", "Error: access_denied"),
	},
] as const;

const brands: ReadonlyArray<{ brand: string; value: OAuthPageBrand | undefined; name?: string; logo?: string }> = [
	{ brand: "unset", value: undefined },
	{ brand: "name only", value: { name: "OmO" }, name: "OmO" },
	{ brand: "name and logo", value: { name: "OmO", logo: LOGO }, name: "OmO", logo: LOGO },
];

const cases = pages.flatMap((page) => brands.map((brand) => ({ ...page, ...brand })));

describe("OAuth result page brand (#4432)", () => {
	afterEach(() => {
		setOAuthPageBrand(undefined);
	});

	test.each(cases)(
		"$page page, brand $brand: no pi logo, the host brand when set",
		({ render, value, name, logo }) => {
			setOAuthPageBrand(value);
			const html = render();

			for (const fragment of PI_LOGO_FRAGMENTS) expect(html).not.toContain(fragment);
			expect(html).not.toContain("<svg");
			if (name) expect(html).toContain(`<div class="brand-name">${name}</div>`);
			else expect(html).not.toContain('class="brand-name"');
			if (logo) expect(html).toContain(`<img class="logo" src="${logo}" alt="" />`);
			else expect(html).not.toContain('class="logo"');
		},
	);

	test.each([
		"data:image/png;base64,AA<b>AA",
		'data:image/svg+xml;base64,AAAA" onerror="alert(1)',
		"data:text/html;base64,PHNjcmlwdD4=",
		"https://example.com/logo.svg",
	])("drops a logo that is not a base64 image data URI: %s", (logo) => {
		setOAuthPageBrand({ name: "OmO", logo });
		const html = oauthSuccessHtml("done");

		expect(html).not.toContain('class="logo"');
		expect(html).toContain('<div class="brand-name">OmO</div>');
	});

	test("escapes the brand name", () => {
		setOAuthPageBrand({ name: "<b>Acme</b>" });

		expect(oauthErrorHtml("failed")).toContain('<div class="brand-name">&lt;b&gt;Acme&lt;/b&gt;</div>');
	});

	test("an empty name leaves the page neutral", () => {
		setOAuthPageBrand({ name: "   ", logo: LOGO });
		const html = oauthSuccessHtml("done");

		expect(html).not.toContain('class="brand-name"');
		expect(html).not.toContain('class="logo"');
	});

	test("the brand is process-wide, so a lazily bundled copy of the module sees it", () => {
		setOAuthPageBrand({ name: "OmO" });

		expect(Reflect.get(globalThis, Symbol.for("@code-yeongyu/senpi-ai:oauth-page-brand"))).toEqual({
			current: { name: "OmO" },
		});
	});
});
