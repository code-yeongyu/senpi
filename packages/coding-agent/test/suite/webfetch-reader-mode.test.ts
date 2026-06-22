import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Static } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { webfetch } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void;
type WebfetchParams = Static<typeof webfetch.parameters>;

const servers: Server[] = [];
const context = {} as ExtensionContext;

async function createFixtureServer(
	handler: RouteHandler,
): Promise<{ readonly baseUrl: string; readonly server: Server }> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Expected TCP server address");
	}
	servers.push(server);
	return { baseUrl: `http://127.0.0.1:${address.port}`, server };
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

function readerFixtureHtml(): string {
	return `<!doctype html>
		<html>
			<head>
				<title>Fixture chrome title</title>
				<meta name="description" content="Fixture promo summary">
				<style>.ad { color: red; }</style>
			</head>
			<body>
				<header>Fixture subscribe banner</header>
				<nav><a href="/latest">Latest fixture link</a></nav>
				<main>
					<article>
						<h1>Readable Fixture Article</h1>
						<p>Alpha fixture paragraph with enough words to be selected as the central article content.</p>
						<p>Beta fixture paragraph should remain after reader cleanup.</p>
					</article>
				</main>
				<aside>Fixture sponsored sidebar</aside>
				<footer>Fixture footer legal links</footer>
				<script>window.fixtureTracker = true;</script>
			</body>
		</html>`;
}

describe("webfetch reader-mode cleanup", () => {
	it("#given article page with chrome #when fetching markdown #then returns reader-style main content", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(readerFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/article`, format: "markdown" });
		const text = textContent(result);

		// then
		expect(text).toContain("## Readable Fixture Article");
		expect(text).toContain("Alpha fixture paragraph");
		expect(text).toContain("Beta fixture paragraph");
		expect(text).not.toContain("Fixture chrome title");
		expect(text).not.toContain("Fixture subscribe banner");
		expect(text).not.toContain("Latest fixture link");
		expect(text).not.toContain("Fixture sponsored sidebar");
		expect(text).not.toContain("Fixture footer legal links");
		expect(text).not.toContain("fixtureTracker");
	});

	it("#given article page with chrome #when fetching text #then returns reader-style main content", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(readerFixtureHtml());
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/article`, format: "text" });
		const text = textContent(result);

		// then
		expect(text).toContain("Readable Fixture Article");
		expect(text).toContain("Alpha fixture paragraph");
		expect(text).toContain("Beta fixture paragraph");
		expect(text).not.toContain("Fixture chrome title");
		expect(text).not.toContain("Fixture subscribe banner");
		expect(text).not.toContain("Latest fixture link");
		expect(text).not.toContain("Fixture sponsored sidebar");
		expect(text).not.toContain("Fixture footer legal links");
		expect(text).not.toContain("fixtureTracker");
	});
});
