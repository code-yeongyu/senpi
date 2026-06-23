import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Static } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { webfetch } from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void;
type WebfetchParams = Static<typeof webfetch.parameters>;
type CapturedHeaders = IncomingMessage["headers"];

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

function headerValue(headers: CapturedHeaders, name: string): string {
	const value = headers[name.toLowerCase()];
	if (Array.isArray(value)) return value.join(", ");
	return value ?? "";
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

	it("#given a web page #when fetching markdown #then sends browser navigation headers", async () => {
		// given
		let capturedHeaders: CapturedHeaders | undefined;
		const server = await createFixtureServer((request, response) => {
			capturedHeaders = request.headers;
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(readerFixtureHtml());
		});

		// when
		await executeWebfetch({ url: `${server.baseUrl}/article`, format: "markdown" });

		// then
		expect(capturedHeaders).toBeDefined();
		if (!capturedHeaders) throw new Error("Expected captured request headers");
		expect(headerValue(capturedHeaders, "user-agent")).toContain("Mozilla/5.0");
		expect(headerValue(capturedHeaders, "accept")).toContain("text/markdown");
		expect(headerValue(capturedHeaders, "accept-language")).toBe("en-US,en;q=0.9");
		expect(headerValue(capturedHeaders, "sec-fetch-mode")).toBe("navigate");
		expect(headerValue(capturedHeaders, "sec-fetch-dest")).toBe("document");
		expect(headerValue(capturedHeaders, "sec-ch-ua-platform")).toBe('"Windows"');
	});

	it("#given a Cloudflare challenge response #when fetching #then does not retry with a bot identity", async () => {
		// given
		const attempts: CapturedHeaders[] = [];
		const server = await createFixtureServer((request, response) => {
			attempts.push(request.headers);
			if (attempts.length === 1) {
				response.writeHead(403, {
					"cf-mitigated": "challenge",
					"content-type": "text/html; charset=utf-8",
				});
				response.end("<html><body>challenge</body></html>");
				return;
			}
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(readerFixtureHtml());
		});

		// when
		await executeWebfetch({ url: `${server.baseUrl}/article`, format: "markdown" });

		// then
		expect(attempts).toHaveLength(1);
		const challengeHeaders = attempts[0];
		if (!challengeHeaders) throw new Error("Expected challenge request headers");
		expect(headerValue(challengeHeaders, "user-agent")).toContain("Mozilla/5.0");
		expect(headerValue(challengeHeaders, "user-agent")).not.toContain("pi-webfetch");
		expect(headerValue(challengeHeaders, "sec-fetch-mode")).toBe("navigate");
		expect(headerValue(challengeHeaders, "sec-fetch-dest")).toBe("document");
		expect(headerValue(challengeHeaders, "sec-ch-ua-platform")).toBe('"Windows"');
	});

	it("#given too many redirects #when fetching #then returns the final redirect response body", async () => {
		// given
		const server = await createFixtureServer((_request, response) => {
			response.writeHead(302, {
				location: "/loop",
				"content-type": "text/plain; charset=utf-8",
			});
			response.end("redirect limit reached");
		});

		// when
		const result = await executeWebfetch({ url: `${server.baseUrl}/loop`, format: "text" });
		const text = textContent(result);

		// then
		expect(text).toContain("redirect limit reached");
	});
});
