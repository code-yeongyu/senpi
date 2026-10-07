import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchUrl } from "../../../src/core/extensions/builtin/webfetch/webfetch/fetcher.ts";
import { discardBody } from "../../../src/core/extensions/builtin/webfetch/webfetch/response-body.ts";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("undici", () => ({ request: requestMock }));

interface DumpOptions {
	readonly limit: number;
	readonly signal?: AbortSignal;
}

interface RedirectBody extends AsyncIterable<Uint8Array> {
	readonly on?: (event: "error", listener: (error: Error) => void) => unknown;
	readonly destroy: (error?: Error) => void;
	readonly dump?: (options?: DumpOptions) => Promise<void>;
}

beforeEach(() => {
	requestMock.mockReset();
});

function queueRedirectResponses(redirectBody: RedirectBody): void {
	requestMock
		.mockResolvedValueOnce({
			statusCode: 302,
			statusText: "Found",
			headers: { location: "/final" },
			body: redirectBody,
		})
		.mockResolvedValueOnce({
			statusCode: 200,
			statusText: "OK",
			headers: { "content-type": "text/plain" },
			body: {
				destroy: vi.fn<(error?: Error) => void>(),
				async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
					yield new TextEncoder().encode("ok");
				},
			},
		});
}

describe("issue #1089 webfetch redirect body cleanup", () => {
	it("destroys without an error when the redirect body has no dump method", async () => {
		// Given
		const cleanupOrder: string[] = [];
		const redirectDestroy = vi.fn<(error?: Error) => void>(() => cleanupOrder.push("destroy"));
		let drained = false;
		queueRedirectResponses({
			destroy: redirectDestroy,
			on: vi.fn((event: "error") => {
				cleanupOrder.push(`listen:${event}`);
			}),
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				cleanupOrder.push("iterate");
				yield new TextEncoder().encode("redirect body");
				drained = true;
			},
		});

		// When
		const result = await fetchUrl({ url: "https://example.test/start", format: "text" });

		// Then
		expect(result.url).toBe("https://example.test/final");
		expect(drained).toBe(true);
		expect(redirectDestroy).toHaveBeenCalledExactlyOnceWith();
		expect(cleanupOrder).toEqual(["listen:error", "iterate", "destroy"]);
	});

	it("handles an already-destroyed body without escaping its cleanup error", async () => {
		// Given
		const destroy = vi.fn<(error?: Error) => void>();
		destroy();
		const body: RedirectBody = {
			destroy,
			on: vi.fn(),
			dump: vi.fn().mockRejectedValue(new Error("body already destroyed")),
			[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
				return {
					next: async () => {
						throw new Error("iteration should not be needed");
					},
				};
			},
		};

		// When
		await expect(discardBody(body, 1024)).resolves.toBeUndefined();

		// Then
		expect(destroy).toHaveBeenCalledTimes(2);
		expect(destroy).toHaveBeenLastCalledWith();
	});

	it("uses dump and then destroys when the redirect body supports dump", async () => {
		// Given
		const dump = vi.fn<(options?: DumpOptions) => Promise<void>>().mockResolvedValue();
		const destroy = vi.fn<(error?: Error) => void>();
		queueRedirectResponses({
			dump,
			destroy,
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				yield new TextEncoder().encode("redirect body");
			},
		});

		// When
		await fetchUrl({ url: "https://example.test/start", format: "text" });

		// Then
		expect(dump).toHaveBeenCalledExactlyOnceWith({ limit: 1024, signal: expect.any(AbortSignal) });
		expect(destroy).toHaveBeenCalledExactlyOnceWith();
	});

	it("swallows a manual-drain failure before destroying the redirect body", async () => {
		const on = vi.fn<(event: "error", listener: (error: Error) => void) => unknown>();
		const destroy = vi.fn<(error?: Error) => void>();
		queueRedirectResponses({
			on,
			destroy,
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				yield new TextEncoder().encode("partial redirect body");
				throw new Error("stream exploded");
			},
		});

		const result = await fetchUrl({ url: "https://example.test/start", format: "text" });

		expect(result.url).toBe("https://example.test/final");
		expect(on).toHaveBeenCalledExactlyOnceWith("error", expect.any(Function));
		expect(destroy).toHaveBeenCalledExactlyOnceWith();
	});

	it("destroys without the dump error when redirect body dumping fails", async () => {
		// Given
		const cleanupOrder: string[] = [];
		const dump = vi.fn<(options?: DumpOptions) => Promise<void>>().mockRejectedValue(new Error("dump failed"));
		const destroy = vi.fn<(error?: Error) => void>(() => cleanupOrder.push("destroy"));
		queueRedirectResponses({
			dump,
			destroy,
			on: vi.fn((event: "error") => {
				cleanupOrder.push(`listen:${event}`);
			}),
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				yield new TextEncoder().encode("redirect body");
			},
		});

		// When
		await fetchUrl({ url: "https://example.test/start", format: "text" });

		// Then
		expect(destroy).toHaveBeenCalledExactlyOnceWith();
		expect(cleanupOrder).toEqual(["listen:error", "destroy"]);
	});

	it("aborts a fallback drain whose iterator never produces a chunk", async () => {
		let markIteratorStarted: () => void = () => {};
		const iteratorStarted = new Promise<void>((resolve) => {
			markIteratorStarted = resolve;
		});
		const destroy = vi.fn<(error?: Error) => void>();
		const body: RedirectBody = {
			destroy,
			[Symbol.asyncIterator]() {
				return {
					next(): Promise<IteratorResult<Uint8Array>> {
						markIteratorStarted();
						return new Promise<IteratorResult<Uint8Array>>(() => {});
					},
				};
			},
		};
		const controller = new AbortController();
		let settled = false;
		const discardPromise = discardBody(body, 1024, controller.signal).then(() => {
			settled = true;
		});

		await iteratorStarted;
		controller.abort(new Error("stop drain"));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(settled).toBe(true);
		expect(destroy).toHaveBeenCalledExactlyOnceWith();
		await discardPromise;
	});

	it("stops fallback iteration after the response-size bound is crossed", async () => {
		let yieldedAfterLimit = false;
		const destroy = vi.fn<(error?: Error) => void>();
		const body: RedirectBody = {
			destroy,
			async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
				yield new Uint8Array(1025);
				yieldedAfterLimit = true;
				yield new Uint8Array(1);
			},
		};

		await discardBody(body, 1024);

		expect(yieldedAfterLimit).toBe(false);
		expect(destroy).toHaveBeenCalledExactlyOnceWith();
	});
});
