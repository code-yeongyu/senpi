import { describe, expect, it } from "vitest";
import {
	kimiCodeRegionForOauthHost,
	kimiCodeRegionPrompt,
	resolveKimiCodeEndpoints,
} from "../src/auth/oauth/kimi-region.ts";

const MAINLAND_OAUTH_HOST = "https://auth.kimi.com";
const GLOBAL_OAUTH_HOST = "https://auth.kimi.ai";
const GLOBAL_API_BASE_URL = "https://api.kimi.ai/coding";

describe("resolveKimiCodeEndpoints", () => {
	it("defaults to kimi.com with no stored or env facts and keeps the catalog base", () => {
		expect(resolveKimiCodeEndpoints({})).toEqual({
			region: "mainland-cn",
			oauthHost: MAINLAND_OAUTH_HOST,
			apiBaseUrl: undefined,
			env: undefined,
		});
	});

	it("moves an international credential to kimi.ai for auth and inference", () => {
		expect(resolveKimiCodeEndpoints({ storedRegion: "global" })).toEqual({
			region: "global",
			oauthHost: GLOBAL_OAUTH_HOST,
			apiBaseUrl: GLOBAL_API_BASE_URL,
			env: { KIMI_CODE_REGION: "global" },
		});
	});

	it("lets the stored region outrank an env host that points elsewhere", () => {
		expect(resolveKimiCodeEndpoints({ storedRegion: "global", envOauthHost: MAINLAND_OAUTH_HOST }).oauthHost).toBe(
			GLOBAL_OAUTH_HOST,
		);
		expect(resolveKimiCodeEndpoints({ storedRegion: "mainland-cn", envRegion: "global" }).oauthHost).toBe(
			MAINLAND_OAUTH_HOST,
		);
	});

	it("maps a known env host onto its region for credentials that predate regions", () => {
		expect(resolveKimiCodeEndpoints({ envOauthHost: `${GLOBAL_OAUTH_HOST}/` })).toMatchObject({
			region: "global",
			apiBaseUrl: GLOBAL_API_BASE_URL,
		});
	});

	it("keeps a custom host verbatim without a region or an inference base", () => {
		expect(resolveKimiCodeEndpoints({ storedOauthHost: "https://auth.example.com///" })).toEqual({
			region: undefined,
			oauthHost: "https://auth.example.com",
			apiBaseUrl: undefined,
			env: { KIMI_CODE_OAUTH_HOST: "https://auth.example.com" },
		});
	});

	it("prefers an explicit env host over an env region and ignores unknown region values", () => {
		expect(resolveKimiCodeEndpoints({ envOauthHost: MAINLAND_OAUTH_HOST, envRegion: "global" }).region).toBe(
			"mainland-cn",
		);
		expect(resolveKimiCodeEndpoints({ storedRegion: "mars", envRegion: "global" }).region).toBe("global");
		expect(resolveKimiCodeEndpoints({ envRegion: "mars" }).region).toBe("mainland-cn");
	});
});

describe("kimiCodeRegionForOauthHost", () => {
	it("recognizes both official hosts regardless of trailing slashes", () => {
		expect(kimiCodeRegionForOauthHost(`${MAINLAND_OAUTH_HOST}/`)).toBe("mainland-cn");
		expect(kimiCodeRegionForOauthHost(GLOBAL_OAUTH_HOST)).toBe("global");
		expect(kimiCodeRegionForOauthHost("https://auth.example.com")).toBeUndefined();
	});
});

describe("kimiCodeRegionPrompt", () => {
	it("offers exactly the two regions the official client knows", () => {
		const prompt = kimiCodeRegionPrompt();
		expect(prompt.type).toBe("select");
		if (prompt.type !== "select") throw new Error("expected a select prompt");
		expect(prompt.options.map((option) => option.id)).toEqual(["mainland-cn", "global"]);
	});
});
