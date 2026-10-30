import type { webcrypto } from "node:crypto";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { appendLoginSlot, listSlots, projectSlot, type PooledCredential } from "../src/auth/pool/slots.ts";
import type { OAuthCredential, ProviderAuthInteraction } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { chatgptSubscriptionProvider } from "../src/providers/chatgpt-subscription.ts";

const ISSUER = "https://auth.openai.com";
const DEVICE = "e61bbe28-07ef-466d-8e5d-a344f94ab305";
let signingKey: webcrypto.CryptoKey;
let publicKey: webcrypto.JsonWebKey;

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	signingKey = pair.privateKey;
	publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
});
afterEach(() => vi.unstubAllGlobals());

function saved(subject: string, clientId = "oaiapp_one"): OAuthCredential {
	return {
		type: "oauth",
		route: "siwc",
		issuer: ISSUER,
		subject,
		clientId,
		email: "shared@example.test",
		idToken: "synthetic-id",
		access: `synthetic-access-${subject}`,
		refresh: `synthetic-refresh-${subject}`,
		expires: 4_102_444_800_000,
		scopes: ["chatgpt.tokens.use.direct"],
	};
}

// #4086 / #5003: tuple identity survives token rotation; email is only display metadata.
it("replaces the same SIWC identity in place while retaining its name, pin, order and siblings", () => {
	const first = saved("one");
	const second = saved("two", "oaiapp_two");
	const pool: PooledCredential = {
		...appendLoginSlot(first, second),
		pinned: "default",
		order: ["default", "login-2"],
	};
	pool.accounts![0].displayName = "Personal";
	const replacement = {
		...first,
		access: "synthetic-new",
		refresh: "synthetic-new-refresh",
		expires: first.expires - 1,
	};
	let committed = "";
	const next = appendLoginSlot(pool, replacement, (name) => {
		committed = name;
	}) as PooledCredential;
	expect(listSlots(next)).toHaveLength(2);
	expect(committed).toBe("default");
	expect(next).toMatchObject({ access: replacement.access, pinned: "default", order: pool.order });
	expect(listSlots(next)[0]).toMatchObject({ name: "default", displayName: "Personal", access: replacement.access });
	expect(projectSlot(next, "default")).toEqual(replacement);
	expect(projectSlot(next, "login-2")).toEqual(second);
});

it.each([{ subject: "different" }, { clientId: "oaiapp_different" }, { issuer: "https://other.example.test" }])(
	"keeps distinct SIWC registrations separate (%j)",
	(difference) => {
		const first = saved("one");
		const next = appendLoginSlot(first, { ...first, ...difference });
		expect(listSlots(next)).toHaveLength(2);
	},
);

it("does not deduplicate an incomplete identity or a legacy account by email", () => {
	const first = saved("one");
	const incomplete = { ...first, subject: undefined };
	expect(listSlots(appendLoginSlot(incomplete, incomplete))).toHaveLength(2);
	const legacy = { ...first, route: undefined };
	expect(listSlots(appendLoginSlot(legacy, first))).toHaveLength(2);
});

it("signs two validated SIWC accounts into the existing provider and replaces a returning identity", async () => {
	const credentials = new InMemoryCredentialStore();
	const legacy: OAuthCredential = {
		type: "oauth",
		access: "synthetic-legacy",
		refresh: "synthetic-legacy-refresh",
		expires: 4_102_444_800_000,
	};
	await credentials.modify("chatgpt-subscription", async () => legacy);
	const models = createModels({ credentials });
	const provider = chatgptSubscriptionProvider();
	models.setProvider(provider);
	let subject = "one";
	let generation = 0;
	let authorize: URL;
	const fetchStub: typeof fetch = async (input) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === `${ISSUER}/.well-known/openid-configuration`)
			return Response.json({ jwks_uri: `${ISSUER}/w11-jwks` });
		if (url === `${ISSUER}/w11-jwks`)
			return Response.json({ keys: [{ ...publicKey, kid: "w11-key", alg: "RS256" }] });
		expect(url).toBe(`${ISSUER}/api/accounts/oauth/token`);
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
		const signed = `${encode({ alg: "RS256", kid: "w11-key" })}.${encode({
			iss: ISSUER,
			sub: subject,
			aud: `oaiapp_${subject}`,
			email: "shared@example.test",
			nonce: authorize.searchParams.get("nonce"),
			exp: 4_102_444_800,
		})}`;
		const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(signed));
		return Response.json({
			access_token: `synthetic-${subject}-${generation}`,
			refresh_token: `synthetic-refresh-${subject}-${generation}`,
			id_token: `${signed}.${Buffer.from(signature).toString("base64url")}`,
			expires_in: 3600,
			scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		});
	};
	vi.stubGlobal("fetch", fetchStub);
	const interaction: ProviderAuthInteraction = {
		signal: new AbortController().signal,
		notify(event) {
			if (event.type === "auth_url") authorize = new URL(event.url);
		},
		async prompt(prompt) {
			expect(prompt.type).toBe("manual_code");
			expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
			const callback = new URL(authorize.searchParams.get("redirect_uri")!);
			callback.search = new URLSearchParams({
				code: "synthetic-code",
				state: authorize.searchParams.get("state")!,
				client_id: `oaiapp_${subject}`,
			}).toString();
			return callback.toString();
		},
	};
	const committed: string[] = [];
	for (subject of ["one", "two", "one"]) {
		generation++;
		const result = await models.login(
			provider.id,
			"oauth",
			{ ...interaction, onAccountCommitted: (receipt) => committed.push(receipt.name) },
			{ getDeviceId: () => DEVICE },
		);
		expect(result).toMatchObject({ route: "siwc", issuer: ISSUER, subject, clientId: `oaiapp_${subject}` });
	}
	expect(committed).toEqual(["login-2", "login-3", "login-2"]);
	const pool = await credentials.read(provider.id);
	expect(listSlots(pool)).toHaveLength(3);
	expect(projectSlot(pool, "default")).toEqual(legacy);
	expect(projectSlot(pool, "login-2")).toMatchObject({ subject: "one", access: "synthetic-one-3" });
	expect(projectSlot(pool, "login-3")).toMatchObject({ subject: "two", access: "synthetic-two-2" });
	expect(provider.auth.oauth?.loginLabel).toBe("Continue with ChatGPT");
});
