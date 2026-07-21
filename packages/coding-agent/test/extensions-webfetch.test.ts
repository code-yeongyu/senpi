import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { fetchUrl, MAX_RESPONSE_SIZE_BYTES } from "../src/core/extensions/builtin/webfetch/webfetch/fetcher.ts";
import { type WebfetchProgressDetails, webfetch } from "../src/core/extensions/builtin/webfetch/webfetch/tool.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

const servers: Server[] = [];
const context = {} as ExtensionContext;

async function createFixtureServer(handler: (response: ServerResponse) => void): Promise<{ readonly url: string }> {
	const server = createServer((_request, response) => handler(response));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Expected TCP server address");
	}
	servers.push(server);
	return { url: `http://127.0.0.1:${address.port}` };
}

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

describe("webfetch progress", () => {
	it("emits fetching, byte-progress, and converting partials without changing the final result", async () => {
		const secondChunk = deferred();
		const downloading = deferred();
		const body = "hello world";
		const { url } = await createFixtureServer((response) => {
			response.writeHead(200, {
				"content-length": Buffer.byteLength(body),
				"content-type": "text/plain",
			});
			response.write("hello ");
			void secondChunk.promise.then(() => response.end("world"));
		});
		const partials: WebfetchProgressDetails[] = [];

		const resultPromise = webfetch.execute(
			"tool",
			{ url, format: "text", timeout: 1 },
			undefined,
			(update) => {
				if (update.details !== undefined && "phase" in update.details) {
					partials.push(update.details);
					if (update.details.phase === "downloading") downloading.resolve();
				}
			},
			context,
		);
		await downloading.promise;
		secondChunk.resolve();
		const result = await resultPromise;

		expect(partials[0]).toMatchObject({
			phase: "fetching",
			url,
			format: "text",
			timeoutSeconds: 1,
			progress: { activity: `fetching ${url}`, maxWaitMs: 1000 },
		});
		const downloadPartials = partials.filter((details) => details.phase === "downloading");
		expect(downloadPartials).not.toHaveLength(0);
		expect(downloadPartials[0]).toMatchObject({
			bytesRead: 6,
			totalBytes: Buffer.byteLength(body),
			progress: { activity: `fetching ${url}`, maxWaitMs: 1000 },
		});
		expect(partials.at(-1)).toMatchObject({
			phase: "converting",
			bytesRead: Buffer.byteLength(body),
			totalBytes: Buffer.byteLength(body),
			progress: { activity: `fetching ${url}`, maxWaitMs: 1000 },
		});
		for (const partial of partials) {
			expect(partial.progress.startedAt).toEqual(expect.any(Number));
		}
		expect(result.content).toEqual([{ type: "text", text: body }]);
		expect(result.details).not.toHaveProperty("progress");
	});

	it("reports monotonic bytes but never reports a chunk that exceeds the response cap", async () => {
		const { url } = await createFixtureServer((response) => {
			response.writeHead(200, { "content-type": "application/octet-stream" });
			response.write(Buffer.alloc(MAX_RESPONSE_SIZE_BYTES, 1));
			response.end(Buffer.from([2]));
		});
		const progress: number[] = [];

		await expect(
			fetchUrl({
				url,
				format: "html",
				onProgress: (bytesRead) => progress.push(bytesRead),
			}),
		).rejects.toThrow("Response too large");

		expect(progress).not.toHaveLength(0);
		expect(progress.at(-1)).toBeLessThanOrEqual(MAX_RESPONSE_SIZE_BYTES);
		expect(progress).toEqual([...progress].sort((left, right) => left - right));
	});
});
