import { describe, expect, it } from "vitest";
import { sanitizeProviderDiagnostic } from "../src/provider-diagnostic.ts";
import { peekProviderDiagnostic } from "../src/utils/provider-diagnostic-carrier.ts";
import {
	awaitProviderTransport,
	transportProviderDiagnosticFromError,
} from "../src/utils/provider-diagnostic-sources.ts";

// senpi#3228: a connection failure is classified `network` from a closed set of structured
// transport codes only; its message is never read.

function withCode(code: string, viaCause: boolean): Error {
	const socket = Object.assign(new Error("socket failure"), { code });
	return viaCause ? new Error("Connection error.", { cause: socket }) : socket;
}

describe("transport provider diagnostic", () => {
	it.each([
		["ECONNRESET", false],
		["ECONNREFUSED", true],
		["ENOTFOUND", true],
		["UND_ERR_SOCKET", true],
	])("classifies %s (via cause: %s) as network", (code, viaCause) => {
		expect(transportProviderDiagnosticFromError(withCode(code, viaCause))).toEqual({
			category: "network",
			code,
			evidence: "structured_transport",
		});
	});

	it("finds the code two causes down, the shape Node's fetch gives under an SDK error", () => {
		const socket = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
		const fetchFailed = new TypeError("fetch failed", { cause: socket });
		const sdkError = new Error("Connection error.", { cause: fetchFailed });
		expect(transportProviderDiagnosticFromError(sdkError)).toEqual({
			category: "network",
			code: "ECONNREFUSED",
			evidence: "structured_transport",
		});
	});

	it.each(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED"])(
		"classifies the undici code %s two causes down (Node) as network",
		(code) => {
			const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("undici"), { code }) });
			expect(
				transportProviderDiagnosticFromError(new Error("Connection error.", { cause: fetchFailed })),
			).toMatchObject({
				category: "network",
				code,
			});
		},
	);

	it("classifies an SDK connection error with no code anywhere by its class name (the SDKs keep name 'Error')", () => {
		class APIConnectionError extends Error {}
		const sdkError = new APIConnectionError("Connection error.", { cause: new TypeError("fetch failed") });
		expect(transportProviderDiagnosticFromError(sdkError)).toEqual({
			category: "network",
			code: "APIConnectionError",
			evidence: "structured_transport",
		});
	});

	it("prefers the runtime's code over the SDK class name", () => {
		class APIConnectionTimeoutError extends Error {
			override name = "APIConnectionTimeoutError";
		}
		const socket = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
		const sdkError = new APIConnectionTimeoutError("Request timed out.", {
			cause: new TypeError("fetch failed", { cause: socket }),
		});
		expect(transportProviderDiagnosticFromError(sdkError)).toMatchObject({ code: "ETIMEDOUT" });
	});

	it("stops after a bounded number of causes", () => {
		let error: Error = Object.assign(new Error("deep"), { code: "ECONNRESET" });
		for (let depth = 0; depth < 6; depth++) error = new Error(`wrap ${depth}`, { cause: error });
		expect(transportProviderDiagnosticFromError(error)).toBeUndefined();
	});

	it("ignores a transport-looking message without a structured code", () => {
		expect(transportProviderDiagnosticFromError(new Error("ECONNRESET: socket hang up"))).toBeUndefined();
	});

	it("ignores an unlisted code", () => {
		expect(transportProviderDiagnosticFromError(withCode("EACCES", false))).toBeUndefined();
	});

	it("keeps an adapter's own verdict and adds network only when the adapter found nothing", async () => {
		const failure = withCode("ECONNRESET", true);
		await expect(
			awaitProviderTransport(
				() => Promise.reject(failure),
				() => undefined,
			),
		).rejects.toBe(failure);
		expect(peekProviderDiagnostic(failure)).toMatchObject({ category: "network", code: "ECONNRESET" });
	});

	it("revalidates a network diagnostic across a boundary and rejects a forged one", () => {
		expect(
			sanitizeProviderDiagnostic({ category: "network", code: "ECONNRESET", evidence: "structured_transport" }),
		).toEqual({
			category: "network",
			code: "ECONNRESET",
			evidence: "structured_transport",
		});
		expect(
			sanitizeProviderDiagnostic({ category: "network", code: "EACCES", evidence: "structured_transport" }),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({
				category: "network",
				httpStatus: 503,
				code: "ECONNRESET",
				evidence: "structured_transport",
			}),
		).toBeUndefined();
	});
});
