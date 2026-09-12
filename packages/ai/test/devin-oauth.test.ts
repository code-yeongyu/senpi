import { afterEach, describe, expect, it, vi } from "vitest";
import { devinOAuth } from "../src/auth/oauth/devin.ts";
import { loadDevinOAuth, loadOpenRouterOAuth } from "../src/auth/oauth/load.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";

const TOKEN_URL = "https://api.devin.ai/auth/cli/token";
const CALLBACK_URL = "http://127.0.0.1:59653/callback";
const FALLBACK_EXPIRY_MS = 31_536_000_000;
const nativeFetch = globalThis.fetch;
const neverAbortedSignal = new AbortController().signal;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Minimal unsigned JWT: only the payload is read by the expiry parser. */
function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type LoginDrive = {
	authorizeUrl: URL | undefined;
	callbackResponse: Promise<Response> | undefined;
	exchangeInit: RequestInit | undefined;
};

/**
 * Drives the real login: waits for the auth_url notification, then calls the
 * loopback callback the flow is listening on, exactly as a browser would.
 */
function driveLogin(
	token: unknown,
	options: { status?: number; state?: (issued: string) => string; raw?: string } = {},
): { drive: LoginDrive; interaction: ProviderAuthInteraction } {
	const drive: LoginDrive = { authorizeUrl: undefined, callbackResponse: undefined, exchangeInit: undefined };
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== TOKEN_URL) return nativeFetch(input, init);
		drive.exchangeInit = init;
		if (options.raw !== undefined) return new Response(options.raw, { status: options.status ?? 200 });
		return jsonResponse(token, options.status ?? 200);
	});
	vi.stubGlobal("fetch", fetchMock);

	const interaction: ProviderAuthInteraction = {
		signal: neverAbortedSignal,
		prompt: () => new Promise<string>(() => {}),
		notify: (event) => {
			if (event.type !== "auth_url") return;
			drive.authorizeUrl = new URL(event.url);
			const redirect = new URL(drive.authorizeUrl.searchParams.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", "authorization-code");
			const issued = drive.authorizeUrl.searchParams.get("state") ?? "";
			redirect.searchParams.set("state", options.state ? options.state(issued) : issued);
			drive.callbackResponse = nativeFetch(redirect);
		},
	};
	return { drive, interaction };
}

describe.sequential("Devin OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("is registered in the OAuth loader registry beside the existing flows", async () => {
		await expect(loadDevinOAuth()).resolves.toBe(devinOAuth);
		await expect(loadOpenRouterOAuth()).resolves.toMatchObject({ name: "OpenRouter OAuth" });
		expect(devinOAuth.name).toBe("Devin");
		expect(devinOAuth.loginLabel).toBe("Sign in with Devin");
	});

	it("exchanges the callback code for the Devin token and derives expiry from the JWT", async () => {
		const exp = Math.floor(Date.now() / 1000) + 3_600;
		const token = jwt({ exp });
		const { drive, interaction } = driveLogin({ token });

		const credential = await devinOAuth.login(interaction);

		expect(credential).toEqual({ type: "oauth", access: token, refresh: token, expires: exp * 1000 });
		expect((await drive.callbackResponse)?.status).toBe(200);
		expect(drive.exchangeInit?.method).toBe("POST");
		expect(new Headers(drive.exchangeInit?.headers).get("accept")).toBe("application/json");
		const body = JSON.parse(String(drive.exchangeInit?.body)) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["code", "code_verifier"]);
		expect(body.code).toBe("authorization-code");
	});

	it("builds the CLI authorize URL with PKCE S256, a uuid state and the loopback redirect", async () => {
		const token = jwt({ exp: Math.floor(Date.now() / 1000) + 60 });
		const { drive, interaction } = driveLogin({ token });

		await devinOAuth.login(interaction);

		expect(drive.authorizeUrl?.origin).toBe("https://app.devin.ai");
		expect(drive.authorizeUrl?.pathname).toBe("/auth/cli/continue");
		expect(drive.authorizeUrl?.searchParams.get("response_type")).toBe("code");
		expect(drive.authorizeUrl?.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
		expect(drive.authorizeUrl?.searchParams.get("prompt")).toBe("select_account");
		expect(drive.authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
		expect(drive.authorizeUrl?.searchParams.get("state")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(drive.authorizeUrl?.searchParams.has("client_id")).toBe(false);

		const body = JSON.parse(String(drive.exchangeInit?.body)) as Record<string, unknown>;
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(body.code_verifier)));
		expect(drive.authorizeUrl?.searchParams.get("code_challenge")).toBe(base64url(new Uint8Array(digest)));
	});

	it("falls back to the one-year expiry when the token carries no usable exp", async () => {
		const token = jwt({ sub: "user" });
		const { interaction } = driveLogin({ token });
		const before = Date.now();

		const credential = await devinOAuth.login(interaction);

		expect(credential.expires).toBeGreaterThanOrEqual(before + FALLBACK_EXPIRY_MS);
		expect(credential.expires).toBeLessThanOrEqual(Date.now() + FALLBACK_EXPIRY_MS);
	});

	it("rejects a callback whose state does not match the issued state", async () => {
		const { drive, interaction } = driveLogin({ token: jwt({ exp: 1 }) }, { state: () => "forged-state" });

		await expect(devinOAuth.login(interaction)).rejects.toThrow(/state/i);
		expect((await drive.callbackResponse)?.status).toBe(400);
	});

	it("surfaces a failed token exchange instead of storing a broken credential", async () => {
		const { drive, interaction } = driveLogin({ error: "invalid_grant" }, { status: 403 });

		await expect(devinOAuth.login(interaction)).rejects.toThrow(/403/);
		expect((await drive.callbackResponse)?.status).toBe(502);
	});

	it("rejects a token response that is not usable JSON", async () => {
		const { interaction } = driveLogin(undefined, { raw: "<html>gateway</html>" });

		await expect(devinOAuth.login(interaction)).rejects.toThrow(/JSON|token/i);
	});

	it("rejects a 200 response that carries no token", async () => {
		const { interaction } = driveLogin({ ok: true });

		await expect(devinOAuth.login(interaction)).rejects.toThrow(/token/i);
	});

	it("has no refresh grant and never overlays the login host onto the Cascade model host", async () => {
		const credential = { type: "oauth", access: "devin-token", refresh: "devin-token", expires: 42 } as const;

		await expect(devinOAuth.refresh(credential, neverAbortedSignal)).resolves.toBe(credential);
		const auth = await devinOAuth.toAuth(credential);
		expect(auth).toEqual({ apiKey: "devin-token" });
		expect(auth.baseUrl).toBeUndefined();
	});
});
