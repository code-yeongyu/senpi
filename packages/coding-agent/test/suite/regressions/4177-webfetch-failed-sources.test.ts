import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webfetch } from "../../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";

const CHALLENGE =
	'<!doctype html><html><head><title>Just a moment...</title></head><body><main><h1>Just a moment...</h1><p>Checking your browser before accessing the source.</p><div class="cf-challenge">Verify you are human</div></main></body></html>';
const ARTICLE = `<!doctype html><html><head><title>How CAPTCHAs work</title></head><body><article><h1>How CAPTCHAs work</h1>${"<p>A CAPTCHA asks you to verify you are human, for example with a g-recaptcha widget, before a form is accepted. Sites use them against automated sign-ups.</p>".repeat(30)}</article></body></html>`;

const servers: Server[] = [];
const context = {} as ExtensionContext;
const previousBrowserSetting = process.env.PI_WEBFETCH_BROWSER;

beforeEach(() => {
	process.env.PI_WEBFETCH_BROWSER = "0";
});

afterEach(async () => {
	if (previousBrowserSetting === undefined) delete process.env.PI_WEBFETCH_BROWSER;
	else process.env.PI_WEBFETCH_BROWSER = previousBrowserSetting;
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(status: number, body: string, contentType = "text/html"): Promise<string> {
	const server = createServer((_request, response) => {
		response.writeHead(status, { "content-type": contentType });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Expected a TCP address");
	return `http://127.0.0.1:${address.port}/source`;
}

function fetchAs(url: string, format: "markdown" | "text" | "html") {
	return webfetch.execute("tool", { url, format, timeout: 5 }, undefined, undefined, context);
}

describe("webfetch reports sources it could not read (senpi#4177)", () => {
	it.each([
		{ status: 403, format: "markdown", reason: "HTTP 403, bot challenge" },
		{ status: 429, format: "text", reason: "HTTP 429, bot challenge" },
		{ status: 200, format: "html", reason: "HTTP 200, bot challenge" },
	] as const)("fails an HTTP $status challenge in $format as a failed source", async ({ status, format, reason }) => {
		const url = await serve(status, CHALLENGE);

		const failure = fetchAs(url, format);

		await expect(failure).rejects.toThrow(`Failed source: ${url} was not retrieved: ${reason}.`);
		await expect(failure).rejects.toThrow("not source content");
	});

	it("fails a plain HTTP 403 without a challenge as denied", async () => {
		const url = await serve(403, "Forbidden", "text/plain");

		await expect(fetchAs(url, "text")).rejects.toThrow(
			`Failed source: ${url} was not retrieved: HTTP 403, access denied.`,
		);
	});

	it("fails an empty HTTP 200 response as unreadable", async () => {
		const url = await serve(200, "", "text/plain");

		await expect(fetchAs(url, "text")).rejects.toThrow(
			`Failed source: ${url} was not retrieved: HTTP 200, no readable content.`,
		);
	});

	it("returns an ordinary article about CAPTCHAs as source content", async () => {
		const url = await serve(200, ARTICLE);

		const result = await fetchAs(url, "markdown");

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("# How CAPTCHAs work") });
	});
});
