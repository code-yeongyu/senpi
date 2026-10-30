import { oauthErrorHtml, oauthSuccessHtml } from "@earendil-works/pi-ai/utils/oauth-page";
import { describe, expect, test } from "vitest";
import { APP_NAME } from "../src/config.ts";
import "../src/core/model-runtime.ts";

describe("sign-in result pages name the running product (#4432)", () => {
	test.each([
		["success", () => oauthSuccessHtml("done")],
		["error", () => oauthErrorHtml("failed")],
	])("%s page carries APP_NAME and no pi logo", (_page, render) => {
		const html = render();

		expect(html).toContain(`<div class="brand-name">${APP_NAME}</div>`);
		expect(html).not.toContain("#F09082");
	});
});
