import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { htmlToSnapshot } from "../../src/core/extensions/builtin/webfetch/webfetch/content.ts";
import { webfetch } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionToolContext } from "../../src/core/extensions/types.ts";

// senpi#5941: the snapshot format is a shipped tool output contract (format value + line grammar).
const PAGE = `<!doctype html><html><head><title>Docs</title><style>nav{}</style><script>track()</script></head><body>
<header><a href="/"><img alt="Acme home" src="/logo.png"></a>
<nav aria-label="Primary"><a href="/docs/start">Get started</a><a href="/docs/api?v=2">API</a>
<a href="https://github.com/acme/acme">GitHub</a><a href="javascript:openMenu()">Menu</a></nav></header>
<main><h1>Guides</h1><p>Read the <a href="/docs/start">Get started</a> guide first.<sup><a href="#note-1">[1]</a></sup></p>
<h2>  Configure   the   client </h2><a href="#install">Install</a><a href="/docs/caf%C3%A9">Café notes</a>
<div hidden><a href="/secret">Hidden link</a></div><a href="/gone" style="display: none">Gone</a>
<form role="search"><label for="q">Search docs</label><input id="q" type="search">
<input type="hidden" name="token" value="x"><select aria-label="Version"><option>v1</option><option>v2</option></select>
<textarea placeholder="Feedback"></textarea><input type="submit" value="Go"><button>Clear</button></form>
<nav aria-label="Empty"></nav></main>
<footer><a href="/privacy">Privacy</a></footer></body></html>`;

const EXPECTED = [
	"== banner ==",
	"[Acme home](/)",
	"== navigation: Primary ==",
	"[Get started](/docs/start)",
	"[API](/docs/api?v=2)",
	"[GitHub](https://github.com/acme/acme)",
	"[button] Menu",
	"== main ==",
	"# Guides",
	"## Configure the client",
	"[Install](#install)",
	"[Café notes](/docs/café)",
	"== search ==",
	"[search input] Search docs",
	"[select] Version: v1 | v2",
	"[textarea] Feedback",
	"[button] Go",
	"[button] Clear",
	"== contentinfo ==",
	"[Privacy](/privacy)",
].join("\n");

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
			),
	);
});

describe("webfetch snapshot format (senpi#5941)", () => {
	it("lists landmarks, headings, links, buttons and fields in document order", () => {
		expect(htmlToSnapshot(PAGE, "https://acme.test/docs/guides")).toBe(EXPECTED);
	});

	it("starts with the page title when the page has no h1", () => {
		const html = "<html><head><title>Inbox</title></head><body><a href='/next'>Next</a></body></html>";
		expect(htmlToSnapshot(html, "https://acme.test/")).toBe("# Inbox\n[Next](/next)");
	});

	it("is selectable through the webfetch tool", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(PAGE);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		servers.push(server);
		const address = server.address();
		if (typeof address !== "object" || address === null) throw new Error("Expected TCP server address");
		const url = `http://127.0.0.1:${address.port}/docs/guides`;

		const result = await webfetch.execute(
			"tool",
			{ url, format: "snapshot" },
			undefined,
			undefined,
			{} as ExtensionToolContext,
		);

		expect(result.content).toEqual([{ type: "text", text: EXPECTED }]);
		expect(result.details).toMatchObject({ format: "snapshot", converted: true });
	});
});
