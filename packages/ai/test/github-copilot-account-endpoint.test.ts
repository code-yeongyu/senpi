import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { githubCopilotOAuth } from "../src/auth/oauth/github-copilot.ts";
import { getModel } from "../src/compat.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#2311 / omo#8662: a Copilot Business or Enterprise account must be served by its own
// API host. GitHub answers a request on another plan's host with `421 Misdirected Request`.

const signal = new AbortController().signal;

function tokenFor(tid: string, proxyEp?: string): string {
	return `tid=${tid};exp=9999999999;sku=copilot_for_business_seat${proxyEp ? `;proxy-ep=${proxyEp}` : ""};8kp=1`;
}

function stubTokenExchange(response: Record<string, unknown>): string[] {
	const requested: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			requested.push(url);
			if (url.includes("/copilot_internal/v2/token")) return Response.json(response);
			if (url.endsWith("/models")) return Response.json({ data: [] });
			throw new Error(`Unexpected fetch URL: ${url}`);
		}),
	);
	return requested;
}

async function refreshAndResolve(response: Record<string, unknown>, enterpriseUrl?: string) {
	const requested = stubTokenExchange(response);
	const credential = await githubCopilotOAuth.refresh(
		{ type: "oauth", access: "stale", refresh: "gho_test", expires: 0, ...(enterpriseUrl ? { enterpriseUrl } : {}) },
		signal,
	);
	const auth = await githubCopilotOAuth.toAuth(credential);
	return { auth, credential, requested };
}

afterEach(() => vi.unstubAllGlobals());

describe("GitHub Copilot requests go to the account's own API host", () => {
	it("uses endpoints.api from the token response for a Business account", async () => {
		const { auth, requested } = await refreshAndResolve({
			token: tokenFor("biz"),
			expires_at: 9999999999,
			endpoints: {
				api: "https://api.business.githubcopilot.com/",
				proxy: "https://proxy.business.githubcopilot.com",
			},
		});

		expect(auth.baseUrl).toBe("https://api.business.githubcopilot.com");
		expect(requested.filter((url) => url.endsWith("/models"))).toEqual([
			"https://api.business.githubcopilot.com/models",
		]);
	});

	it("prefers endpoints.api over the token's proxy-ep and the individual host for an Enterprise tenant", async () => {
		const { auth } = await refreshAndResolve({
			token: tokenFor("ent", "proxy.enterprise.githubcopilot.com"),
			expires_at: 9999999999,
			endpoints: { api: "https://api.octo-corp.ghe.com" },
		});

		expect(auth.baseUrl).toBe("https://api.octo-corp.ghe.com");
	});

	it("derives the host from proxy-ep when the token response lists no endpoints", async () => {
		const { auth } = await refreshAndResolve({
			token: tokenFor("biz2", "proxy.business.githubcopilot.com"),
			expires_at: 9999999999,
		});

		expect(auth.baseUrl).toBe("https://api.business.githubcopilot.com");
	});

	it("never lets a stored endpoint serve a different token", async () => {
		const auth = await githubCopilotOAuth.toAuth({
			type: "oauth",
			access: tokenFor("other-account", "proxy.individual.githubcopilot.com"),
			refresh: "gho_test",
			expires: 9999999999000,
			copilotApiEndpoint: { tid: "biz", url: "https://api.business.githubcopilot.com" },
		});

		expect(auth.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});

	it("routes a Copilot token passed as an explicit key to the host its proxy-ep names", async () => {
		const apiKey = githubCopilotProvider().auth.apiKey;
		if (!apiKey) throw new Error("github-copilot has no api-key auth");

		const result = await apiKey.resolve({
			ctx: { env: async () => undefined, fileExists: async () => false },
			credential: { type: "api_key", key: tokenFor("biz4", "proxy.business.githubcopilot.com") },
			signal,
		});

		expect(result?.auth.baseUrl).toBe("https://api.business.githubcopilot.com");
	});

	it("explains a 421 Misdirected Request with the GitHub request id", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 421, headers: { "x-github-request-id": "AB12:3456" } })),
		);
		let message = "";
		for await (const event of streamCompletions(
			getModel("github-copilot", "kimi-k3"),
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] }),
			{ apiKey: tokenFor("biz5") },
		)) {
			if (event.type === "error") message = event.error.errorMessage ?? "";
		}

		expect(message).toContain("HTTP 421 Misdirected Request");
		expect(message).toContain("/login github-copilot");
		expect(message).toContain("GitHub request id: AB12:3456");
	});

	it("ignores an endpoints.api that is not an https URL", async () => {
		const { auth } = await refreshAndResolve({
			token: tokenFor("biz3", "proxy.business.githubcopilot.com"),
			expires_at: 9999999999,
			endpoints: { api: "http://attacker.example" },
		});

		expect(auth.baseUrl).toBe("https://api.business.githubcopilot.com");
	});
});
