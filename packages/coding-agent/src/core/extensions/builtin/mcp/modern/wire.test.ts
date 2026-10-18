import { describe, expect, it } from "vitest";
import {
	buildModernRequest,
	classifyHttpProbeError,
	classifyModernError,
	classifyStdioProbeError,
	deriveModernHeaders,
	parseModernResult,
} from "./wire.ts";

const client = { name: "senpi", version: "test" };
const capabilities = { elicitation: { form: {} } };
const rpcError = (code: number, data?: unknown) => ({
	jsonrpc: "2.0",
	id: 1,
	error: { code, message: "failure", ...(data === undefined ? {} : { data }) },
});

describe("modern MCP request wire format", () => {
	it("builds discovery with only the metadata triple", () => {
		const request = buildModernRequest(1, "server/discover", client, {});

		expect(request).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": client,
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		});
	});

	it("preserves params and application metadata without allowing reserved overrides", () => {
		const params = {
			name: "echo",
			arguments: { text: "hello" },
			_meta: {
				progressToken: 7,
				"io.modelcontextprotocol/protocolVersion": "old",
				"io.modelcontextprotocol/clientInfo": {},
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		};

		const request = buildModernRequest("call", "tools/call", client, capabilities, params);

		expect(request.params).toEqual({
			...params,
			_meta: {
				progressToken: 7,
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": client,
				"io.modelcontextprotocol/clientCapabilities": capabilities,
			},
		});
		expect(params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("old");
	});

	it.each(["server/discover", "tools/list", "resources/list", "prompts/list", "ping"])(
		"derives matching version and method headers for %s without session headers",
		(method) => {
			const request = buildModernRequest(1, method, client, {});

			expect(deriveModernHeaders(request)).toEqual({
				"MCP-Protocol-Version": request.params._meta["io.modelcontextprotocol/protocolVersion"],
				"Mcp-Method": method,
			});
		},
	);

	it.each([
		["tools/call", { name: "echo" }, "echo"],
		["prompts/get", { name: "summarize" }, "summarize"],
		["resources/read", { uri: "file:///notes.txt", name: "ignored" }, "file:///notes.txt"],
		["tools/call", { name: "\uD55C\uAE00" }, "base64:7ZWc6riA"],
		["resources/read", { uri: "x:\u00FF" }, "base64:eDrDvw"],
		["prompts/get", { name: "line\nbreak" }, "base64:bGluZQpicmVhaw"],
		["tools/call", { name: "base64:literal" }, "base64:YmFzZTY0OmxpdGVyYWw"],
	])("encodes the routing header for %s %j", (method, params, expected) => {
		const request = buildModernRequest(1, method, client, {}, params);

		expect(deriveModernHeaders(request)["Mcp-Name"]).toBe(expected);
	});

	it("omits routing names on methods that do not define them", () => {
		const request = buildModernRequest(1, "tools/list", client, {}, { name: "not-a-route" });

		expect(deriveModernHeaders(request)["Mcp-Name"]).toBeUndefined();
	});
});

describe("modern MCP result envelopes", () => {
	it.each(["complete", "input_required", "future_extension"])("preserves the %s result and metadata", (resultType) => {
		const result = {
			resultType,
			supportedVersions: ["2026-07-28"],
			capabilities: {},
			_meta: { "io.modelcontextprotocol/serverInfo": { name: "server", version: "1" } },
			instructions: "fixture",
			ttlMs: 100,
			cacheScope: "public",
		};

		expect(parseModernResult({ jsonrpc: "2.0", id: 1, result })).toEqual(result);
	});

	it("treats an absent legacy resultType as complete", () => {
		expect(parseModernResult({ jsonrpc: "2.0", id: 1, result: { tools: [] } })).toEqual({
			resultType: "complete",
			tools: [],
		});
	});

	it.each([
		null,
		[],
		{},
		{ result: null },
		{ jsonrpc: "1.0", result: {} },
		{ jsonrpc: "2.0", result: { resultType: 3 } },
		{ jsonrpc: "2.0", result: {}, error: { code: -32603, message: "failure" } },
	])("rejects malformed result envelopes %j", (value) => {
		expect(() => parseModernResult(value)).toThrow();
	});
});

describe("modern MCP probe error taxonomy", () => {
	it("recognizes unsupported versions by code and retains data.supported", () => {
		const body = rpcError(-32022, { supported: ["2026-07-28", "future"], requested: "old" });

		expect(classifyModernError(body)).toEqual({
			kind: "UnsupportedProtocolVersionError",
			code: -32022,
			message: "failure",
			data: body.error.data,
			supportedVersions: ["2026-07-28", "future"],
		});
	});

	it.each([
		[-32020, "HeaderMismatch"],
		[-32021, "MissingRequiredClientCapabilityError"],
		[-32022, "UnsupportedProtocolVersionError"],
	])("keeps code %s modern even on HTTP 400 or stdio", (code, kind) => {
		const body = rpcError(code);

		expect(classifyModernError(body)?.kind).toBe(kind);
		expect(classifyHttpProbeError(400, JSON.stringify(body))).toBe("modern");
		expect(classifyStdioProbeError(body)).toBe("modern");
	});

	it.each([
		"",
		"<html>bad request</html>",
		"{",
		null,
		{},
		[],
		rpcError(-32601),
		rpcError(-32602),
		rpcError(-32603),
		rpcError(-32099),
		{ jsonrpc: "2.0", error: { code: -32022 } },
		{ error: { code: -32022, message: "failure" } },
	])("falls back only for empty or unrecognized probe bodies %j", (body) => {
		expect(classifyModernError(body)).toBeUndefined();
		expect(classifyHttpProbeError(400, body)).toBe("legacy");
		expect(classifyStdioProbeError(body)).toBe("legacy");
	});

	it.each([401, 403, 404, 429, 500])("does not turn HTTP %s into a legacy fallback", (status) => {
		expect(classifyHttpProbeError(status, "")).toBe("indeterminate");
	});

	it("does not infer modern identity from an error message", () => {
		expect(
			classifyModernError({
				jsonrpc: "2.0",
				error: {
					code: -32602,
					message: "HeaderMismatch",
				},
			}),
		).toBeUndefined();
	});
});
