import { describe, expect, it, vi } from "vitest";
import { loadMcpSdkAuth } from "../sdk.lazy.ts";
import { type ProbeRequest, probeHttpEra, probeStdioEra, StdioProbeSilence } from "./era.ts";

const options = {
	clientInfo: { name: "senpi", version: "test" },
	clientCapabilities: { elicitation: {} },
	supportedVersions: ["2026-07-28", "2026-06-01"],
};
const discovery = {
	jsonrpc: "2.0",
	id: 1,
	result: {
		resultType: "complete",
		supportedVersions: ["2026-07-28"],
		capabilities: { tools: {} },
		_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
	},
};
const rpcError = (code: number, message: string, data: unknown = {}) => ({
	jsonrpc: "2.0",
	id: 1,
	error: { code, message, data },
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// senpi#4402: -32022 selects an implemented era, not merely an implemented modern version.
describe("unsupported protocol version negotiation", () => {
	it.each(["HTTP", "stdio"] as const)("%s falls back when only legacy versions are mutual", async (transport) => {
		const error = rpcError(-32022, "UnsupportedProtocolVersionError", {
			supported: ["2025-06-18", "2025-03-26"],
		});
		const send = vi.fn(async (request: ProbeRequest) => ({ ...error, id: request.id }));
		const fetch = vi.fn(async () => reply(error, 400));
		const outcome =
			transport === "HTTP"
				? await probeHttpEra(new URL("https://fixture.test"), fetch, options)
				: await probeStdioEra(send, options);
		expect(outcome).toEqual({ kind: "legacy-fallback" });
		expect(transport === "HTTP" ? fetch : send).toHaveBeenCalledTimes(1);
	});

	it.each(["HTTP", "stdio"] as const)(
		"%s names unsupported server versions in an actionable error",
		async (transport) => {
			const supported = ["2099-01-01", "1900-01-01"];
			const error = rpcError(-32022, "UnsupportedProtocolVersionError", { supported });
			const outcome =
				transport === "HTTP"
					? await probeHttpEra(new URL("https://fixture.test"), async () => reply(error, 400), options)
					: await probeStdioEra(async (request) => ({ ...error, id: request.id }), options);
			expect(outcome).toMatchObject({ kind: "indeterminate", reason: "no-mutual-version", era: "modern" });
			if (outcome.kind !== "indeterminate") throw new Error("Expected an actionable negotiation error");
			for (const version of supported) expect(outcome.action).toContain(version);
			expect(outcome.action).toMatch(/update/i);
		},
	);

	it.each(["HTTP", "stdio"] as const)("%s still retries modern when both eras are mutual", async (transport) => {
		const error = rpcError(-32022, "UnsupportedProtocolVersionError", {
			supported: ["2025-06-18", "2026-06-01"],
		});
		const fetch = vi.fn(async () => reply(discovery)).mockResolvedValueOnce(reply(error, 400));
		const send = vi
			.fn(async (request: ProbeRequest): Promise<unknown> => ({ ...discovery, id: request.id }))
			.mockImplementationOnce(async (request) => ({ ...error, id: request.id }));
		const outcome =
			transport === "HTTP"
				? await probeHttpEra(new URL("https://fixture.test"), fetch, options)
				: await probeStdioEra(send, options);
		expect(outcome).toMatchObject({ kind: "modern-version-retry", version: "2026-06-01" });
		expect(transport === "HTTP" ? fetch : send).toHaveBeenCalledTimes(2);
	});
});

describe("HTTP era detection", () => {
	it("detects modern discovery and sends matching per-request metadata and headers", async () => {
		const fetch = vi.fn(async (_url: URL, _init: RequestInit) => reply(discovery));
		const result = await probeHttpEra(new URL("https://fixture.test/mcp"), fetch, options);
		expect(result).toMatchObject({ kind: "modern-OK", version: "2026-07-28", discovery: discovery.result });
		const init = fetch.mock.calls[0]?.[1];
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "server/discover",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": options.clientInfo,
					"io.modelcontextprotocol/clientCapabilities": options.clientCapabilities,
				},
			},
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retries exactly once with the newest mutual version", async () => {
		const fetch = vi
			.fn(async (_url: URL, _init: RequestInit) => reply(discovery))
			.mockResolvedValueOnce(
				reply(
					rpcError(-32022, "UnsupportedProtocolVersionError", {
						supported: ["2026-01-01", "2026-06-01", "2026-07-28"],
					}),
					400,
				),
			);
		const result = await probeHttpEra(new URL("https://fixture.test"), fetch, options);
		expect(result).toMatchObject({ kind: "modern-version-retry", version: "2026-07-28" });
		expect(fetch).toHaveBeenCalledTimes(2);
		const init = fetch.mock.calls[1]?.[1];
		expect(new Headers(init?.headers).get("MCP-Protocol-Version")).toBe(
			JSON.parse(String(init?.body)).params._meta["io.modelcontextprotocol/protocolVersion"],
		);
	});

	it.each(["", "not JSON", JSON.stringify(rpcError(-32601, "Method not found"))])(
		"falls back on an empty or unrecognized HTTP 400 body: %s",
		async (body) => {
			const fetch = vi.fn(async () => new Response(body, { status: 400 }));
			expect(await probeHttpEra(new URL("https://fixture.test"), fetch, options)).toEqual({
				kind: "legacy-fallback",
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["HeaderMismatch", "MissingCapabilityError"])(
		"does not infer modern from generic error text %s",
		async (name) => {
			const error = rpcError(-32000, name, { type: name });
			expect(await probeHttpEra(new URL("https://fixture.test"), async () => reply(error, 400), options)).toEqual({
				kind: "legacy-fallback",
			});
			expect(await probeStdioEra(async (request) => ({ ...error, id: request.id }), options)).toEqual({
				kind: "legacy-fallback",
			});
		},
	);

	it.each([
		[-32020, "HeaderMismatch"],
		[-32021, "MissingRequiredClientCapabilityError"],
	] as const)("retains modern classification on %s", async (code, name) => {
		const error = rpcError(code, name);
		const result = await probeHttpEra(new URL("https://fixture.test"), async () => reply(error, 400), options);
		expect(result).toMatchObject({ kind: "modern-OK", error: error.error });
	});

	it.each([401, 403, 404, 429, 500])("surfaces an actionable error on HTTP %s", async (status) => {
		const result = await probeHttpEra(new URL("https://fixture.test"), async () => reply({}, status), options);
		expect(result).toMatchObject({ kind: "indeterminate", reason: "http-status", status });
	});

	it.each([200, 404])("falls back when HTTP %s carries a generic JSON-RPC error", async (status) => {
		const fetch = vi.fn(async () => reply(rpcError(-32601, "Method not found"), status));
		expect(await probeHttpEra(new URL("https://fixture.test"), fetch, options)).toEqual({ kind: "legacy-fallback" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("passes an authorization failure through instead of hiding it as a transport error", async () => {
		const { UnauthorizedError } = await loadMcpSdkAuth();
		const unauthorized = new UnauthorizedError();
		await expect(
			probeHttpEra(
				new URL("https://fixture.test"),
				async () => {
					throw unauthorized;
				},
				options,
			),
		).rejects.toBe(unauthorized);
	});

	it("surfaces network failures rather than selecting legacy", async () => {
		const result = await probeHttpEra(
			new URL("https://fixture.test"),
			async () => {
				throw new TypeError("offline");
			},
			options,
		);
		expect(result).toMatchObject({ kind: "indeterminate", reason: "transport", action: expect.any(String) });
	});

	it("does not downgrade on absent mutual versions or a rejected retry", async () => {
		const fetch = vi.fn(async () =>
			reply(
				rpcError(-32022, "UnsupportedProtocolVersionError", {
					supported: ["2026-06-01"],
				}),
				400,
			),
		);
		expect(await probeHttpEra(new URL("https://fixture.test"), fetch, options)).toMatchObject({
			kind: "indeterminate",
			reason: "version-retry-rejected",
			era: "modern",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(
			await probeHttpEra(new URL("https://fixture.test"), fetch, {
				...options,
				supportedVersions: ["2026-07-28"],
			}),
		).toMatchObject({ kind: "indeterminate", reason: "no-mutual-version", era: "modern" });
	});

	it("rejects a malformed success instead of assuming legacy", async () => {
		expect(
			await probeHttpEra(new URL("https://fixture.test"), async () => reply({ result: {} }), options),
		).toMatchObject({ kind: "indeterminate", reason: "invalid-discovery" });
	});

	it("consumes a per-request SSE discovery response without a GET stream", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(`event: message\ndata: ${JSON.stringify(discovery)}\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				}),
		);
		expect(await probeHttpEra(new URL("https://fixture.test"), fetch, options)).toMatchObject({ kind: "modern-OK" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("stdio era detection", () => {
	const answer = (body: Record<string, unknown>) => async (request: ProbeRequest) => ({ ...body, id: request.id });

	it("sends discover with only metadata under an id the SDK never uses, and recognizes its envelope", async () => {
		const send = vi.fn(answer(discovery));
		expect(await probeStdioEra(send, options)).toMatchObject({ kind: "modern-OK" });
		const request = send.mock.calls[0]?.[0];
		expect(request).toMatchObject({ method: "server/discover" });
		expect(typeof request?.id).toBe("string");
		expect(Object.keys(request?.params ?? {})).toEqual(["_meta"]);
	});

	it("does not accept a discovery reply addressed to another id", async () => {
		expect(await probeStdioEra(async () => discovery, options)).toEqual({ kind: "legacy-fallback", restart: true });
	});

	it.each([-32020, -32021])("recognizes modern error %s", async (value) => {
		expect(await probeStdioEra(answer(rpcError(value, String(value))), options)).toMatchObject({ kind: "modern-OK" });
	});

	it("retries once with the newest mutual version on -32022", async () => {
		const send = vi
			.fn(answer(discovery))
			.mockImplementationOnce(answer(rpcError(-32022, "Unsupported", { supported: ["2026-06-01", "2027-01-01"] })));
		expect(await probeStdioEra(send, options)).toMatchObject({ kind: "modern-version-retry", version: "2026-06-01" });
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]?.[0].params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-06-01");
		expect(send.mock.calls[1]?.[0].id).not.toBe(send.mock.calls[0]?.[0].id);
	});

	it("keeps the process for a clean nonmodern error reply", async () => {
		expect(await probeStdioEra(answer(rpcError(-32601, "Method not found")), options)).toEqual({
			kind: "legacy-fallback",
		});
	});

	it.each([{}, undefined, { jsonrpc: "2.0", result: {} }])(
		"asks for a fresh process after an unclean reply %j",
		async (body) => {
			expect(await probeStdioEra(async () => body, options)).toEqual({ kind: "legacy-fallback", restart: true });
		},
	);

	it("keeps the process on silence so a slow start is not killed", async () => {
		expect(
			await probeStdioEra(async () => {
				throw new StdioProbeSilence();
			}, options),
		).toEqual({ kind: "legacy-fallback", silent: true });
	});

	const retries: [string, (request: ProbeRequest) => Promise<unknown>][] = [
		["silence", () => Promise.reject(new StdioProbeSilence())],
		["an exit", () => Promise.reject(new Error("closed"))],
		["a generic error", async (request) => ({ ...rpcError(-32601, "Method not found"), id: request.id })],
	];
	it.each(retries)(
		"never downgrades a server that already answered -32022 when the retry meets %s",
		async (_name, retry) => {
			const send = vi
				.fn(retry)
				.mockImplementationOnce(answer(rpcError(-32022, "Unsupported", { supported: ["2026-06-01"] })));
			expect(await probeStdioEra(send, options)).toMatchObject({ kind: "indeterminate", era: "modern" });
		},
	);

	it("asks for a fresh process after a transport failure or exit", async () => {
		expect(
			await probeStdioEra(async () => {
				throw new Error("closed");
			}, options),
		).toEqual({ kind: "legacy-fallback", restart: true });
	});
});
