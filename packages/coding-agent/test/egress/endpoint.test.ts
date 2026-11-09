import { describe, expect, it } from "vitest";
import { composeEndpointUrl, splitEndpoint, type UrlSecretField } from "../../src/core/egress/endpoint.ts";

const BRACED_ACCOUNT = ["$", "{ACCOUNT}"].join("");

function secretsOf(baseUrl: string, marked: Parameters<typeof splitEndpoint>[1] = []): Record<string, string> {
	const split = splitEndpoint(baseUrl, marked);
	if (!split.ok) throw new Error(`unexpected refusal: ${split.reason}`);
	return Object.fromEntries(split.secrets);
}

describe("splitEndpoint URL secret marking", () => {
	it("keeps a plain URL entirely public", () => {
		const split = splitEndpoint("https://api.example.test:8443/v1/chat?api-version=2025-01-01");
		expect(split).toEqual({
			ok: true,
			endpoint: {
				scheme: "https",
				host: "api.example.test",
				port: 8443,
				path: ["v1", "chat"],
				query: { "api-version": "2025-01-01" },
			},
			secrets: new Map(),
		});
	});

	it("seals userinfo always", () => {
		expect(secretsOf("https://user:pw@host.test/v1")).toEqual({ urlUserinfo: "user:pw" });
	});

	it("splits userinfo on the last @ so a password tail never lands in the public host", () => {
		const split = splitEndpoint("https://a@b@host.test/v1");
		expect(split.ok && split.endpoint.host).toBe("host.test");
		expect(secretsOf("https://a@b@host.test/v1")).toEqual({ urlUserinfo: "a@b" });
	});

	it.each([
		["https://host.test/accounts/$ACCOUNT/v1", { "urlPath:1": "$ACCOUNT" }],
		[`https://host.test/accounts/${BRACED_ACCOUNT}/v1`, { "urlPath:1": BRACED_ACCOUNT }],
		["https://host.test/a?q=$TOKEN_VALUE", { "urlQuery:q": "$TOKEN_VALUE" }],
	])("seals a templated part of %s", (url, expected) => {
		expect(secretsOf(url)).toEqual(expected);
	});

	it("does not treat an escaped dollar as a template", () => {
		expect(secretsOf("https://host.test/price$$1")).toEqual({});
	});

	it.each([
		"key",
		"api_key",
		"api-key",
		"apikey",
		"token",
		"access_token",
		"sig",
		"signature",
		"sv",
		"API_KEY",
		"client_secret",
		"password",
		"auth",
		"x-api-key",
	])("seals the value of the key-ish query name %s", (name) => {
		expect(secretsOf(`https://host.test/v1?${name}=abc&model=m`)).toEqual({ [`urlQuery:${name}`]: "abc" });
	});

	it("seals the parts the user marked", () => {
		expect(secretsOf("https://host.test/tenant-7/v1?project=p1", ["urlPath:0", "urlQuery:project"])).toEqual({
			"urlPath:0": "tenant-7",
			"urlQuery:project": "p1",
		});
	});

	it.each([
		["ftp://host.test/x", "scheme"],
		["https://host.test/x#frag", "fragment"],
		["https://host.test/x?a=1&a=2", "duplicate-query"],
		["https://host.test/x?flag", "valueless-query"],
		["not a url", "unparseable"],
	])("refuses %s (%s) instead of guessing", (url, reason) => {
		expect(splitEndpoint(url)).toEqual({ ok: false, reason });
	});

	it.each([
		"https://host.test",
		"https://host.test/",
		"http://u:p@host.test:80/a/$X/b/?key=k&model=m",
		"https://host.test/a//b?",
	])("composes %s back byte-identical from its split", (url) => {
		const split = splitEndpoint(url);
		if (!split.ok) throw new Error(split.reason);
		const secret = (field: UrlSecretField): string => {
			const value = split.secrets.get(field);
			if (value === undefined) throw new Error(`missing ${field}`);
			return value;
		};
		expect(composeEndpointUrl(split.endpoint, secret)).toBe(url);
	});
});
