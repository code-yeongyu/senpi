import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinModels } from "../src/providers/all.ts";
import {
	discoverAntigravityProject,
	googleAntigravityOAuth,
	refreshAntigravityToken,
} from "../src/utils/oauth/google-antigravity.ts";
import {
	discoverGeminiCliProject,
	googleGeminiCliOAuth,
	refreshGoogleCloudToken,
} from "../src/utils/oauth/google-gemini-cli.ts";
import { googleOAuthExports } from "../src/utils/oauth/google-oauth-shared.ts";
import { getOAuthProvider } from "../src/utils/oauth/index.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe.sequential("Google account OAuth providers", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("registers distinct OAuth and model providers without replacing google", () => {
		expect(getOAuthProvider("google-gemini-cli")?.id).toBe("google-gemini-cli");
		expect(getOAuthProvider("google-antigravity")?.id).toBe("google-antigravity");
		const models = builtinModels();
		expect(models.getProvider("google")?.auth.apiKey).toBeDefined();
		expect(models.getProvider("google-gemini-cli")?.auth.oauth).toBeDefined();
		expect(models.getProvider("google-antigravity")?.auth.oauth).toBeDefined();
		expect(models.getModels("google-gemini-cli").length).toBeGreaterThan(0);
		expect(models.getModels("google-antigravity").length).toBeGreaterThan(0);
	});

	it("uses explicit Cloud Code Assist catalogs rather than cloned public Google rows", () => {
		const models = builtinModels();
		expect(
			models
				.getModels("google-gemini-cli")
				.map((model) => model.id)
				.sort(),
		).toEqual([
			"gemini-2.0-flash",
			"gemini-2.5-flash",
			"gemini-2.5-pro",
			"gemini-3-flash-preview",
			"gemini-3-pro-preview",
			"gemini-3.1-flash-lite-preview",
			"gemini-3.1-pro-preview",
			"gemini-3.5-flash",
		]);
		expect(
			models
				.getModels("google-antigravity")
				.map((model) => model.id)
				.sort(),
		).toEqual([
			"claude-opus-4-5-thinking",
			"claude-opus-4-6-thinking",
			"claude-sonnet-4-5",
			"claude-sonnet-4-5-thinking",
			"claude-sonnet-4-6",
			"claude-sonnet-4-6-thinking",
			"gemini-2.5-flash",
			"gemini-2.5-flash-thinking",
			"gemini-2.5-pro",
			"gemini-3-flash",
			"gemini-3-pro-high",
			"gemini-3-pro-low",
			"gemini-3.1-pro-low",
			"gpt-oss-120b-medium",
		]);
		expect(models.getModel("google-gemini-cli", "gemini-3-pro-preview")).toMatchObject({
			thinkingLevelMap: { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(models.getModel("google-antigravity", "gpt-oss-120b-medium")).toMatchObject({
			input: ["text"],
			contextWindow: 114_000,
			maxTokens: 32_768,
		});
	});

	it("keeps node:http behind the Google OAuth Node-only module", async () => {
		const source = await readFile(new URL("../src/utils/oauth/google-oauth-shared.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/\bimport\s*\(\s*["']node:http["']\s*\)/);
	});

	it.each([
		["Gemini CLI", discoverGeminiCliProject, { cloudaicompanionProject: "gemini-project" }, "gemini-project"],
		[
			"Antigravity",
			discoverAntigravityProject,
			{ cloudaicompanionProject: { id: "antigravity-project" } },
			"antigravity-project",
		],
	] as const)("discovers the %s Cloud Code Assist project without external network", async (_name, discover, response, expected) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json(response)),
		);
		await expect(discover("access-secret")).resolves.toBe(expected);
	});

	it.each([
		["Gemini CLI", refreshGoogleCloudToken],
		["Antigravity", refreshAntigravityToken],
	] as const)("refreshes %s credentials and retains a rotated-or-existing refresh token", async (_name, refresh) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ access_token: "new-access", expires_in: 3600 })),
		);
		await expect(refresh("refresh-secret", "project-1")).resolves.toMatchObject({
			access: "new-access",
			refresh: "refresh-secret",
			projectId: "project-1",
		});
	});

	it.each([
		["Gemini CLI", refreshGoogleCloudToken],
		["Antigravity", refreshAntigravityToken],
	] as const)("redacts %s token response bodies from errors", async (_name, refresh) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ error: "invalid_grant", access_token: "leaked-access" }, 400)),
		);
		const error = await refresh("refresh-secret", "project-1").catch((value: unknown) => value);
		expect(String(error)).not.toContain("refresh-secret");
		expect(String(error)).not.toContain("leaked-access");
	});

	it.each([
		["Gemini CLI", googleGeminiCliOAuth],
		["Antigravity", googleAntigravityOAuth],
	] as const)("cancels %s callback waiting from the caller signal", async (_name, oauth) => {
		const controller = new AbortController();
		const login = oauth.login({
			notify: () => controller.abort(new DOMException("cancelled", "AbortError")),
			prompt: async ({ signal }) =>
				await new Promise<string>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			signal: controller.signal,
		});
		await expect(login).rejects.toMatchObject({ name: "AbortError" });
	});

	it("aborts the manual-code prompt when callback authentication wins", async () => {
		const nativeFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })),
		);
		const { auth } = googleOAuthExports({
			id: "google-callback-test",
			name: "Google callback test",
			clientId: "client-id",
			clientSecret: "client-secret",
			port: 18085,
			path: "/oauth2callback",
			scopes: ["scope"],
			discoverProject: async () => "project-from-discovery",
		});
		let callbackRequest: Promise<Response> | undefined;
		let manualSignal: AbortSignal | undefined;
		const credentials = await auth.login({
			notify: (event) => {
				if (event.type !== "auth_url") return;
				const authorizationUrl = new URL(event.url);
				const callbackUrl = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
				callbackUrl.searchParams.set("code", "callback-code");
				callbackUrl.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
				callbackRequest = nativeFetch(callbackUrl);
			},
			prompt: async ({ signal }) => {
				manualSignal = signal;
				return await new Promise<string>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});
		await callbackRequest;
		expect(credentials).toMatchObject({ access: "access", projectId: "project-from-discovery" });
		expect(manualSignal).toBeDefined();
		expect(manualSignal?.aborted).toBe(true);
	});

	it("falls back to manual input when the Gemini CLI callback port is occupied", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve, reject) => {
			blocker.once("error", reject);
			blocker.listen(8085, "127.0.0.1", resolve);
		});
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) =>
					String(input).includes("/token")
						? json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
						: json({ cloudaicompanionProject: "project-from-discovery" }),
				),
			);
			let state = "";
			const credentials = await getOAuthProvider("google-gemini-cli")!.login({
				onAuth: ({ url }) => {
					state = new URL(url).searchParams.get("state") ?? "";
				},
				onDeviceCode: () => {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
				onManualCodeInput: async () => `?code=manual-code&state=${state}`,
			});
			expect(credentials).toMatchObject({ access: "access", projectId: "project-from-discovery" });
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("serializes a nonempty projectId into runtime auth and rejects its absence", async () => {
		const auth = googleGeminiCliOAuth;
		await expect(
			auth.toAuth({
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 1000,
				projectId: "project-1",
			}),
		).resolves.toEqual({ apiKey: JSON.stringify({ token: "access", projectId: "project-1" }) });
		await expect(
			auth.toAuth({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 1000 }),
		).rejects.toThrow(/projectId/);
	});
});
