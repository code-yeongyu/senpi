import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type AuthType, type Model } from "@earendil-works/pi-ai";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getCredentialAccounts } from "../../src/core/credential-accounts.ts";
import accountExtension from "../../src/core/extensions/builtin/account/index.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAccountCommandContext, registerCommand } from "./account-command-harness.ts";

const PROVIDER = "kimi-coding";
const regions = ["mainland-cn", "global"] as const;
let dir: string;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimi-account-pool-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
	for (const name of ["KIMI_CODE_REGION", "KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST", "KIMI_API_KEY"]) {
		vi.stubEnv(name, "");
	}
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

async function loginPair(type: AuthType) {
	const provider = kimiCodingProvider();
	const models = createModels({ credentials: storage });
	models.setProvider(provider);
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input);
			requests.push(url.href);
			const region = url.hostname === "auth.kimi.ai" ? "global" : "mainland-cn";
			if (url.pathname === "/api/oauth/device_authorization") {
				return Response.json({
					device_code: `device-${region}`,
					user_code: "TEST",
					verification_uri: "https://www.kimi.com/code",
					verification_uri_complete: "https://www.kimi.com/code?user_code=TEST",
					interval: 1,
					expires_in: 600,
				});
			}
			if (url.pathname === "/api/oauth/token") {
				return Response.json({
					access_token: `access-${region}`,
					refresh_token: `refresh-${region}`,
					expires_in: 3600,
				});
			}
			throw new Error(`Unexpected network request: ${url.href}`);
		}),
	);
	for (const region of regions) {
		let deviceReady = () => {};
		const device = new Promise<void>((resolve) => {
			deviceReady = resolve;
		});
		const login = models.login(PROVIDER, type, {
			prompt: async (prompt) => (prompt.type === "select" ? region : `key-${region}`),
			notify: (event) => {
				if (event.type === "device_code") deviceReady();
			},
		});
		if (type === "oauth") {
			await device;
			await vi.advanceTimersByTimeAsync(1000);
		}
		await login;
	}
	if (type === "oauth") {
		expect(requests).toEqual(
			["auth.kimi.com", "auth.kimi.ai"].flatMap((host) => [
				`https://${host}/api/oauth/device_authorization`,
				`https://${host}/api/oauth/token`,
			]),
		);
	} else {
		expect(requests).toEqual([]);
	}
	return provider;
}

async function consume(runtime: ModelRuntime, model: Model<"anthropic-messages">) {
	const events = [];
	for await (const event of runtime.stream(model, { messages: [], tools: [] }, { sessionId: "kimi-pool" })) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	expect(events.at(-1)?.type).toBe("done");
}

describe.each(["oauth", "api_key"] as const)("Kimi %s accounts in the shared pool", (type) => {
	it("appends logins, lists, pins and resolves each region, rotates on 429, and removes independently", async () => {
		vi.useFakeTimers();
		const provider = await loginPair(type);
		vi.useRealTimers();
		const slots = listSlots(await storage.read(PROVIDER));
		expect(slots).toHaveLength(2);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "login-2"]);
		for (const [index, region] of regions.entries()) {
			expect(slots[index]).toMatchObject({
				name: index === 0 ? "default" : "login-2",
				env: { KIMI_CODE_REGION: region },
				...(type === "oauth"
					? { access: `access-${region}`, refresh: `refresh-${region}` }
					: { key: `key-${region}` }),
			});
		}
		expect((await getCredentialAccounts(storage, PROVIDER, {})).map((account) => account.name)).toEqual([
			"default",
			"login-2",
		]);
		const command = registerCommand("account", accountExtension);
		const { ctx, notices } = createAccountCommandContext(storage, dir);
		await command.handler(`${PROVIDER} list`, ctx);
		expect(notices.at(-1)?.message).toContain("default | login | available");
		expect(notices.at(-1)?.message).toContain("login-2 | login | available");
		expect(notices.at(-1)?.message).not.toMatch(/access-|refresh-|key-/);

		// Replace only inference transport: login, storage, auth resolution and
		// ModelRuntime's account selection/failover remain the production paths.
		const faux = fauxProvider({ provider: PROVIDER });
		const bases: string[] = [];
		const observed: typeof provider = {
			...provider,
			stream: (model, context, options) => {
				bases.push(model.baseUrl);
				return faux.provider.stream(model, context, options);
			},
		};
		const runtime = await ModelRuntime.create({
			credentials: storage,
			modelsPath: null,
			agentDir: dir,
			allowModelNetwork: false,
		});
		await runtime.registerNativeProvider(observed);
		await runtime.refresh({ allowNetwork: false, providers: [PROVIDER] });
		const model = provider.getModels()[0];
		if (!model) throw new Error("Kimi provider has no model");
		for (const [index, region] of regions.entries()) {
			await command.handler(`${PROVIDER} pin ${index === 0 ? "default" : "login-2"}`, ctx);
			faux.setResponses([fauxAssistantMessage("ok")]);
			await consume(runtime, model);
			const call = faux.getCallLog().at(-1);
			expect(bases.at(-1)).toBe(`https://api.kimi.${region === "global" ? "ai" : "com"}/coding`);
			if (type === "oauth") {
				expect(call?.options?.headers).toMatchObject({ Authorization: `Bearer access-${region}` });
			} else {
				expect(call?.options?.apiKey).toBe(`key-${region}`);
			}
		}
		await command.handler(`${PROVIDER} pin default`, ctx);
		const beforeRotation = faux.getCallLog().length;
		faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limited" }),
			fauxAssistantMessage("rotated"),
		]);
		await consume(runtime, model);
		const rotated = faux.getCallLog().slice(beforeRotation);
		expect(rotated).toHaveLength(2);
		expect(bases.slice(beforeRotation)).toEqual(["https://api.kimi.com/coding", "https://api.kimi.ai/coding"]);
		for (const [index, region] of regions.entries()) {
			if (type === "oauth") {
				expect(rotated[index]?.options?.headers).toMatchObject({ Authorization: `Bearer access-${region}` });
			} else {
				expect(rotated[index]?.options?.apiKey).toBe(`key-${region}`);
			}
		}
		expect(await getCredentialAccounts(storage, PROVIDER, {})).toMatchObject([
			{ name: "default", blocked: true },
			{ name: "login-2", blocked: false },
		]);
		await command.handler(`${PROVIDER} unpin`, ctx);
		expect((await getCredentialAccounts(storage, PROVIDER, {})).every((account) => !account.pinned)).toBe(true);
		await command.handler(`${PROVIDER} remove default`, ctx);
		expect(listSlots(await storage.read(PROVIDER))).toEqual([slots[1]]);
	});
});
