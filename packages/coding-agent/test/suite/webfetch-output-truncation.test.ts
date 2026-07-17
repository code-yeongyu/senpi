import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Static } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_OUTPUT_MAX_BYTES,
	type WebfetchDetails,
	webfetch,
} from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
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

function webfetchDetails(result: Awaited<ReturnType<typeof executeWebfetch>>): WebfetchDetails {
	const details = result.details;
	if (details === undefined || !("status" in details)) {
		throw new Error("Expected webfetch result details");
	}
	return details;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

describe("webfetch output truncation", () => {
	it("caps a huge single-line JSON body so it cannot blow the context window", async () => {
		// Reproduces the reported bug: fetching models.dev/api.json (~3MB of
		// minified, single-line JSON) returned the entire payload to the model
		// and forced an unwanted compaction. The body is one line, so line-aware
		// truncation alone would drop everything — a byte-accurate fallback must
		// keep the head.
		const hugeJson = `{"data":"${"x".repeat(2 * 1024 * 1024)}"}`;
		const { baseUrl } = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(hugeJson);
		});

		const result = await executeWebfetch({ url: baseUrl, format: "text" });
		const text = textContent(result);
		const details = webfetchDetails(result);

		// Model-facing output is bounded, not the full ~2MB payload.
		expect(details.outputTruncated).toBe(true);
		expect(details.outputBytes).toBeLessThanOrEqual(DEFAULT_OUTPUT_MAX_BYTES);
		expect(details.outputTotalBytes).toBeGreaterThan(2 * 1024 * 1024);
		expect(details.outputBytes).toBeLessThan(details.outputTotalBytes);
		// Head content is preserved (not empty) and an actionable notice is appended.
		expect(text).toContain('{"data":"xxxx');
		expect(text).toContain("truncated");
	});

	it("truncates a large multi-line body while keeping whole leading lines", async () => {
		const bigText = `${Array.from({ length: 5000 }, (_, i) => `line-${i}-${"y".repeat(40)}`).join("\n")}\n`;
		const { baseUrl } = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(bigText);
		});

		const result = await executeWebfetch({ url: baseUrl, format: "text" });
		const text = textContent(result);
		const details = webfetchDetails(result);

		expect(details.outputTruncated).toBe(true);
		expect(details.outputBytes).toBeLessThanOrEqual(DEFAULT_OUTPUT_MAX_BYTES);
		expect(text.startsWith("line-0-")).toBe(true);
		expect(text).toContain("truncated");
	});

	it("returns a small body verbatim with no truncation notice", async () => {
		const body = "hello world\nsecond line\n";
		const { baseUrl } = await createFixtureServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.end(body);
		});

		const result = await executeWebfetch({ url: baseUrl, format: "text" });
		const text = textContent(result);
		const details = webfetchDetails(result);

		expect(details.outputTruncated).toBe(false);
		expect(text).toBe(body);
		expect(text).not.toContain("truncated");
	});
});
