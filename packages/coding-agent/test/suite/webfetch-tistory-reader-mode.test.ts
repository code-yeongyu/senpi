import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Static } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { webfetch } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void;
type WebfetchParams = Static<typeof webfetch.parameters>;

const servers: Server[] = [];
const context = {} as ExtensionContext;

async function createFixtureServer(handler: RouteHandler): Promise<{ readonly baseUrl: string }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Expected TCP server address");
	}
	servers.push(server);
	return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function executeWebfetch(params: WebfetchParams) {
	return webfetch.execute("tool", params, undefined, undefined, context);
}

function textContent(result: Awaited<ReturnType<typeof executeWebfetch>>): string {
	const first = result.content[0];
	if (first?.type !== "text") {
		throw new Error("Expected text content");
	}
	return first.text;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function tistoryFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<head>
				<title>Admin menu must not beat the title</title>
				<meta name="description" content="Tistory blog promotional tagline">
			</head>
			<body class="tt-body-page">
				<header>
					<a href="/manage">Manage</a>
					<a href="/category">View all categories</a>
				</header>
				<section class="sidebar">
					<h2>Recent posts</h2>
					<p>A long irrelevant sidebar description must not make the reader mistake this area for the body.</p>
				</section>
				<div id="content">
					<h1 class="tit_post">We must read the Tistory article body</h1>
					<div class="entry-content contents_style">
						<div class="article_view tt_article_useless_p_margin">
							<p data-ke-size="size16">The first body sentence must remain even in a short Tistory post.</p>
							<p data-ke-size="size16">The second body sentence must take precedence over categories or related posts.</p>
							<figure data-ke-type="image">
								<figcaption>Body image captions are preserved too.</figcaption>
							</figure>
						</div>
						<div class="another_category">
							<h4>See other posts</h4>
							<ul>
								<li>Related post title one</li>
								<li>Related post title two</li>
							</ul>
						</div>
					</div>
				</div>
				<footer>Subscribe footer and guestbook link</footer>
				<script>window.tistoryTracker = true;</script>
			</body>
		</html>`;
}

function titlePriorityFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<head>
				<title>Admin menu must not beat the title</title>
				<meta name="description" content="Tistory blog promotional tagline">
			</head>
			<body class="tt-body-page">
				<header>
					<h1>Blog name</h1>
					<a href="/manage">Manage</a>
					<a href="/category">View all categories</a>
				</header>
				<section class="sidebar">
					<h2>Recent posts</h2>
					<p>A long irrelevant sidebar description must not make the reader mistake this area for the body.</p>
				</section>
				<div id="content">
					<h1 class="tit_post">We must read the Tistory article body</h1>
					<div class="entry-content contents_style">
						<div class="article_view tt_article_useless_p_margin">
							<p data-ke-size="size16">The first body sentence must remain even in a short Tistory post.</p>
							<p data-ke-size="size16">The second body sentence must take precedence over categories or related posts.</p>
							<figure data-ke-type="image">
								<figcaption>Body image captions are preserved too.</figcaption>
							</figure>
						</div>
						<div class="another_category">
							<h4>See other posts</h4>
							<ul>
								<li>Related post title one</li>
								<li>Related post title two</li>
							</ul>
						</div>
					</div>
				</div>
				<footer>Subscribe footer and guestbook link</footer>
			</body>
		</html>`;
}

function newlineFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<body>
				<div class="article_view">
					<h1>Preserve line breaks</h1>
					<p><span>First line</span><br><span>Second line</span></p>
					<p><span>New paragraph</span> <strong>emphasis</strong></p>
					<ul>
						<li><span>First item</span></li>
						<li><span>Second item</span></li>
					</ul>
					<table>
						<tr><td>Left cell</td><td>Right cell</td></tr>
					</table>
				</div>
			</body>
		</html>`;
}

function literalEntityFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<body>
				<article>
					<h1>Literal Entity Fixture</h1>
					<p>Rendered tag example: &amp;lt;custom-element&amp;gt;</p>
					<p>Escaped ampersand example: AT&amp;amp;T docs</p>
				</article>
			</body>
		</html>`;
}

describe("webfetch Tistory reader-mode cleanup", () => {
	it("#given Tistory article wrappers #when fetching markdown #then prefers the article body over category chrome", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(tistoryFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/tistory`, format: "markdown" });
		const text = textContent(result);

		// then
		expect(text).toContain("# We must read the Tistory article body");
		expect(text).toContain("The first body sentence must remain");
		expect(text).toContain("The second body sentence must take precedence");
		expect(text).toContain("Body image captions are preserved too");
		expect(text).not.toContain("Admin menu must not beat the title");
		expect(text).not.toContain("View all categories");
		expect(text).not.toContain("Recent posts");
		expect(text).not.toContain("Related post title");
		expect(text).not.toContain("Subscribe footer");
		expect(text).not.toContain("tistoryTracker");
	});

	it("#given Tistory title chrome #when fetching markdown #then prefers the article title over site chrome", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(titlePriorityFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/tistory-title`, format: "markdown" });
		const text = textContent(result);

		// then
		expect(text).toContain("# We must read the Tistory article body");
		expect(text).toContain("The first body sentence must remain");
		expect(text).toContain("The second body sentence must take precedence");
		expect(text).not.toContain("Blog name");
		expect(text).not.toContain("irrelevant sidebar description");
	});

	it("#given Tistory title chrome #when fetching text #then prefers the article title over site chrome", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(titlePriorityFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/tistory-title-text`, format: "text" });
		const text = textContent(result);

		// then
		expect(text.startsWith("We must read the Tistory article body")).toBe(true);
		expect(text).toContain("The first body sentence must remain");
		expect(text).toContain("The second body sentence must take precedence");
		expect(text).not.toContain("Blog name");
		expect(text).not.toContain("irrelevant sidebar description");
	});

	it("#given Tistory text with inline spans and blocks #when fetching text #then preserves readable line breaks", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(newlineFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/newline`, format: "text" });
		const text = textContent(result);

		// then
		expect(text).toContain("Preserve line breaks\n\nFirst line\nSecond line\n\nNew paragraph emphasis");
		expect(text).toContain("First item\n\nSecond item");
		expect(text).toContain("Left cell\nRight cell");
		expect(text).not.toContain("\n\n\n");
		expect(text).not.toContain("First lineSecond line");
	});

	it("#given literal HTML entity examples #when fetching markdown and text #then preserves one decoded layer only", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(literalEntityFixtureHtml());
		});

		// when
		const markdown = textContent(
			await executeWebfetch({ url: `${server.baseUrl}/literal-entity`, format: "markdown" }),
		);
		const text = textContent(await executeWebfetch({ url: `${server.baseUrl}/literal-entity`, format: "text" }));

		// then
		expect(markdown).toContain("&lt;custom-element&gt;");
		expect(markdown).toContain("AT&amp;T docs");
		expect(markdown).not.toContain("<custom-element>");
		expect(markdown).not.toContain("AT&T docs");
		expect(text).toContain("&lt;custom-element&gt;");
		expect(text).toContain("AT&amp;T docs");
		expect(text).not.toContain("<custom-element>");
		expect(text).not.toContain("AT&T docs");
	});
});
