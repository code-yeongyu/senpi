import { join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import { AuthStorage } from "../../../core/auth-storage.ts";
import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../../../core/credential-accounts.ts";
import type { ProviderAccountEvent } from "../../../core/extensions/builtin/claude-sdk-oauth/account-events.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type {
	AccountReadParams,
	AccountReadResponse,
	ProviderAccountsPinParams,
	ProviderAccountsReadParams,
	ProviderAccountsReadResponse,
	ProviderAccountsRemoveParams,
} from "../protocol/account.ts";
import type { RpcNotification } from "../rpc/envelope.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import type { MethodRegistry } from "../rpc/registry.ts";

export interface RegisterAppServerAccountMethodsOptions {
	readonly agentDir?: string;
}

const RATE_LIMITS_AUTHENTICATION_MESSAGE = "codex account authentication required to read rate limits";
const TOKEN_USAGE_AUTHENTICATION_MESSAGE = "codex account authentication required to read token usage";

export function registerAppServerAccountMethods(
	registry: MethodRegistry,
	options: RegisterAppServerAccountMethodsOptions = {},
): void {
	const agentDir = resolvePath(options.agentDir ?? getAgentDir());

	registry.register("account/read", {
		scope: "global",
		handler: ({ request }) => {
			parseAccountReadParams(request.params);
			return accountReadResponse(agentDir);
		},
	});
	registry.register("account/providerAccounts/read", {
		scope: "global",
		handler: ({ request }) => providerAccountsResponse(agentDir, parseProviderAccountsReadParams(request.params)),
	});
	registry.register("account/providerAccounts/pin", {
		scope: "global",
		handler: async ({ request }) => {
			const params = parseProviderAccountsPinParams(request.params);
			await pinCredentialAccount(AuthStorage.create(join(agentDir, "auth.json")), params.provider, params.name);
			return {};
		},
	});
	registry.register("account/providerAccounts/remove", {
		scope: "global",
		handler: async ({ request }) => {
			const params = parseProviderAccountsRemoveParams(request.params);
			await removeCredentialAccount(AuthStorage.create(join(agentDir, "auth.json")), params.provider, params.name);
			return {};
		},
	});
	registry.register("account/rateLimits/read", {
		scope: "global",
		handler: () => {
			throw unauthenticatedAccountReadError(RATE_LIMITS_AUTHENTICATION_MESSAGE);
		},
	});
	registry.register("account/usage/read", {
		scope: "global",
		handler: () => {
			throw unauthenticatedAccountReadError(TOKEN_USAGE_AUTHENTICATION_MESSAGE);
		},
	});
}

export function providerAccountEventNotification(event: ProviderAccountEvent): RpcNotification {
	if (event.type === "accounts_changed") {
		return { method: "account/providerAccounts/updated", params: { provider: event.provider } };
	}
	return {
		method: "account/providerAccounts/failover",
		params: { provider: event.provider, from: event.from, to: event.to, reason: event.reason },
	};
}

function accountReadResponse(agentDir: string): AccountReadResponse {
	const credentials = AuthStorage.create(join(agentDir, "auth.json")).getAll();
	return {
		account: Object.keys(credentials).length > 0 ? { type: "apiKey" } : null,
		requiresOpenaiAuth: false,
	};
}

async function providerAccountsResponse(
	agentDir: string,
	params: ProviderAccountsReadParams,
): Promise<ProviderAccountsReadResponse> {
	const storage = AuthStorage.create(join(agentDir, "auth.json"));
	return { provider: params.provider, accounts: await getCredentialAccounts(storage, params.provider) };
}

function parseAccountReadParams(value: unknown): AccountReadParams {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		throw new RpcHandlerError({ code: -32600, message: "account/read params must be an object" });
	}
	const refreshToken = value.refreshToken;
	if (refreshToken !== undefined && typeof refreshToken !== "boolean") {
		throw new RpcHandlerError({ code: -32600, message: "account/read refreshToken must be a boolean" });
	}
	return refreshToken === undefined ? {} : { refreshToken };
}

function parseProviderAccountsReadParams(value: unknown): ProviderAccountsReadParams {
	return { provider: providerFrom(value, "account/providerAccounts/read") };
}

function parseProviderAccountsPinParams(value: unknown): ProviderAccountsPinParams {
	const params = requiredRecord(value, "account/providerAccounts/pin");
	if (typeof params.name !== "string" && params.name !== null) {
		throw invalidParams("account/providerAccounts/pin name must be a string or null");
	}
	return { provider: requiredProvider(params, "account/providerAccounts/pin"), name: params.name };
}

function parseProviderAccountsRemoveParams(value: unknown): ProviderAccountsRemoveParams {
	const params = requiredRecord(value, "account/providerAccounts/remove");
	if (typeof params.name !== "string" || params.name.length === 0) {
		throw invalidParams("account/providerAccounts/remove name must be a non-empty string");
	}
	return { provider: requiredProvider(params, "account/providerAccounts/remove"), name: params.name };
}

function providerFrom(value: unknown, method: string): string {
	return requiredProvider(requiredRecord(value, method), method);
}

function requiredProvider(params: Record<string, unknown>, method: string): string {
	if (typeof params.provider !== "string" || params.provider.length === 0) {
		throw invalidParams(`${method} provider must be a non-empty string`);
	}
	return params.provider;
}

function requiredRecord(value: unknown, method: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalidParams(`${method} params must be an object`);
	return value;
}

function invalidParams(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function unauthenticatedAccountReadError(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
