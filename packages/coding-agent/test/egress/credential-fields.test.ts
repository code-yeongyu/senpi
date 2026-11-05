import { describe, expect, it } from "vitest";
import {
	CREDENTIAL_SLOT_FIELDS,
	type CredentialDeviceReason,
	classifyCredentialField,
	credentialDeviceReasons,
} from "../../src/core/egress/credential-fields.ts";

describe("stored credential fields", () => {
	it.each([
		["api_key", "key", "sealed"],
		["api_key", "env", "forces-device"],
		["oauth", "access", "sealed"],
		["oauth", "refresh", "device-only"],
		["oauth", "idToken", "device-only"],
		["oauth", "scopes", "device-only"],
		["oauth", "planUsageEnabled", "public"],
		["oauth", "route", "public"],
	] as const)("%s.%s is %s", (type, key, expected) => {
		expect(classifyCredentialField(type, key)).toBe(expected);
	});

	it.each(["tenantSecret", "constructor", "__proto__", "toString"])(
		"keeps a credential with the undeclared OAuth key %s on the device",
		(key) => {
			expect(classifyCredentialField("oauth", key)).toBe("forces-device");
		},
	);
});

describe("pool slot fields", () => {
	it("keeps the display name (often an e-mail) and the refresh token on the device", () => {
		expect(CREDENTIAL_SLOT_FIELDS.displayName).toBe("device-only");
		expect(CREDENTIAL_SLOT_FIELDS.refresh).toBe("device-only");
	});
});

describe("a ChatGPT sign-in with a route", () => {
	const siwcLogin = {
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: 1,
		idToken: "i",
		subject: "s",
		email: "me@x.test",
		clientId: "c",
		scopes: ["s"],
		planUsageEnabled: true,
		route: "siwc",
	} as const;

	it("stays servable by sealed custody, in a stored login and in a pool slot", () => {
		expect(credentialDeviceReasons(siwcLogin)).toEqual([]);
		expect(
			credentialDeviceReasons({
				type: "oauth",
				accounts: [{ name: "a", access: "a", route: "siwc" }],
				order: ["a"],
			}),
		).toEqual([]);
	});

	it("sends the route as plain config and nothing secret beside it", () => {
		const plain = Object.keys(siwcLogin).filter((key) => classifyCredentialField("oauth", key) === "public");
		expect(plain.sort()).toEqual(["expires", "planUsageEnabled", "route", "type"]);
		expect(CREDENTIAL_SLOT_FIELDS.route).toBe("public");
	});
});

describe("credentialDeviceReasons", () => {
	it.each([
		["a plain api key", { type: "api_key", key: "k", env: {}, loginId: "l" }],
		["a plain OAuth token", { type: "oauth", access: "a", refresh: "r", expires: 1, scopes: ["s"] }],
		[
			"a pool without env",
			{ type: "api_key", accounts: [{ name: "a", key: "k", displayName: "me@x.test" }], order: ["a"] },
		],
	])("lets %s be served by sealed custody", (_name, credential) => {
		expect(credentialDeviceReasons(credential)).toEqual([]);
	});

	const cases: readonly (readonly [string, Record<string, unknown>, CredentialDeviceReason])[] = [
		["api key env", { type: "api_key", key: "k", env: { CLOUDFLARE_ACCOUNT_ID: "a1" } }, "env"],
		["pool slot env", { type: "api_key", accounts: [{ name: "a", key: "k", env: { REGION: "cn" } }] }, "env"],
		[
			"an undeclared OAuth key",
			{ type: "oauth", access: "a", refresh: "r", expires: 1, tenant: "t" },
			"undeclared-field",
		],
		["an undeclared slot key", { type: "api_key", accounts: [{ name: "a", secret: "s" }] }, "undeclared-field"],
		["an unknown credential type", { type: "session_cookie", value: "c" }, "undeclared-field"],
		["accounts that are not a list", { type: "api_key", accounts: { a: {} } }, "undeclared-field"],
	];
	it.each(cases)("keeps a credential with %s on the device", (_name, credential, reason) => {
		expect(credentialDeviceReasons(credential)).toEqual([reason]);
	});
});
