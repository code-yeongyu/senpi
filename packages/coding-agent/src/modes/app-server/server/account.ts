import { join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import { AuthStorage } from "../../../core/auth-storage.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type { AccountReadParams, AccountReadResponse } from "../protocol/account.ts";
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

function accountReadResponse(agentDir: string): AccountReadResponse {
	const credentials = AuthStorage.create(join(agentDir, "auth.json")).getAll();
	return {
		account: Object.keys(credentials).length > 0 ? { type: "apiKey" } : null,
		requiresOpenaiAuth: false,
	};
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

function unauthenticatedAccountReadError(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
