import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { ModelsError } from "../src/auth/resolve.ts";
import type { ApiKeyAuth, OAuthAuth } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";

function requestToken(environment: unknown): string | undefined {
	if (typeof environment !== "object" || environment === null || Array.isArray(environment)) return undefined;
	const value = Object.entries(environment).find(([name]) => name === "REQUEST_TOKEN")?.[1];
	return typeof value === "string" ? value : undefined;
}

describe("auth resolution regressions", () => {
	it("wraps a stored OAuth availability failure with provider context", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("failing-oauth", async () => ({
			type: "oauth",
			access: "stored-token",
			refresh: "stored-refresh",
			expires: Date.now() + 60_000,
		}));
		const cause = new Error("availability probe failed");
		const oauth: OAuthAuth = {
			name: "Failing OAuth",
			login: async () => {
				throw new Error("not used");
			},
			refresh: async (credential) => credential,
			check: async () => {
				throw cause;
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const models = createModels({ credentials });
		models.setProvider({
			id: "failing-oauth",
			name: "Failing OAuth",
			auth: { oauth },
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		});

		let failure: unknown;
		try {
			await models.getAuth("failing-oauth");
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(ModelsError);
		if (!(failure instanceof ModelsError)) throw new Error("expected ModelsError");
		expect(failure.code).toBe("auth");
		expect(failure.message).toContain("failing-oauth");
		expect(failure.cause).toBe(cause);
	});

	it("lets an explicit empty request env value mask the host", async () => {
		const apiKey: ApiKeyAuth = {
			name: "Host-backed",
			resolve: async ({ ctx }) => ({ auth: { apiKey: await ctx.env("TOKEN") } }),
		};
		const models = createModels({
			authContext: {
				env: async (name) => (name === "TOKEN" ? "host-token" : undefined),
				fileExists: async () => false,
			},
		});
		models.setProvider({
			id: "empty-mask",
			name: "Empty mask",
			auth: { apiKey },
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		});

		const resolved = await models.getAuth("empty-mask", { env: { TOKEN: "" } });

		expect(resolved?.auth.apiKey).toBe("");
	});

	it("refreshes an expired OAuth credential before checking availability", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("refresh-before-check", async () => ({
			type: "oauth",
			access: "expired-access",
			refresh: "refresh-token",
			expires: 0,
		}));
		let refreshes = 0;
		let checkedAccess: string | undefined;
		const oauth: OAuthAuth = {
			name: "Refresh before check",
			login: async () => {
				throw new Error("not used");
			},
			refresh: async (credential) => {
				refreshes++;
				return { ...credential, access: "fresh-access", expires: Date.now() + 60_000 };
			},
			check: async ({ credential }) => {
				checkedAccess = credential?.access;
				return credential?.access === "fresh-access" ? { type: "oauth", source: "fresh" } : undefined;
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const models = createModels({ credentials });
		models.setProvider({
			id: "refresh-before-check",
			name: "Refresh before check",
			auth: { oauth },
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		});

		const resolved = await models.getAuth("refresh-before-check");

		expect(resolved?.auth.apiKey).toBe("fresh-access");
		expect(refreshes).toBe(1);
		expect(checkedAccess).toBe("fresh-access");
	});

	it("passes the effective request environment to OAuth check and derivation", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("effective-oauth-env", async () => ({
			type: "oauth",
			access: "stored-access",
			refresh: "stored-refresh",
			expires: Date.now() + 60_000,
		}));
		let checkedToken: string | undefined;
		let derivedToken: string | undefined;
		const oauth: OAuthAuth = {
			name: "Effective OAuth environment",
			login: async () => {
				throw new Error("not used");
			},
			refresh: async (credential) => credential,
			check: async ({ credential }) => {
				checkedToken = requestToken(credential?.env);
				return checkedToken ? { type: "oauth", source: "request" } : undefined;
			},
			toAuth: async (credential) => {
				derivedToken = requestToken(credential.env);
				return { apiKey: derivedToken };
			},
		};
		const models = createModels({ credentials });
		models.setProvider({
			id: "effective-oauth-env",
			name: "Effective OAuth environment",
			auth: { oauth },
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		});

		const resolved = await models.getAuth("effective-oauth-env", {
			env: { REQUEST_TOKEN: "request-token" },
		});

		expect(checkedToken).toBe("request-token");
		expect(derivedToken).toBe("request-token");
		expect(resolved?.auth.apiKey).toBe("request-token");
	});
});
