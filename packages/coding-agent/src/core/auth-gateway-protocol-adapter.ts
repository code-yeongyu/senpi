import type { AssistantMessageEventStream, Context } from "@earendil-works/pi-ai/compat";
import { type TSchema, Type } from "typebox";
import type { AuthBrokerCredentialSelector } from "./auth-broker-wire-contract.ts";

export type AuthGatewayAdapterInput = {
	readonly context: Context;
	readonly modelId: string;
	readonly provider: string;
	readonly selector?: AuthBrokerCredentialSelector;
	readonly signal?: AbortSignal;
};

export type AuthGatewayAdapterStreamResult =
	| { readonly kind: "aborted"; readonly statusCode: 499 }
	| { readonly kind: "model_not_found"; readonly statusCode: 404 }
	| { readonly kind: "overloaded"; readonly statusCode: 503 }
	| {
			readonly kind: "stream";
			readonly leaseId: string;
			readonly model: { readonly id: string };
			readonly stream: AssistantMessageEventStream;
	  };

export interface AuthGatewayAdapterRuntime {
	stream(input: AuthGatewayAdapterInput): Promise<AuthGatewayAdapterStreamResult>;
}

export type AuthGatewayAdapterRequest = {
	readonly body: unknown;
	readonly headers?: Readonly<Record<string, string | undefined>>;
	readonly signal?: AbortSignal;
};

export type AuthGatewaySseFrame = { readonly data: unknown; readonly event: string };

export type AuthGatewayAdapterResponse =
	| { readonly body: unknown; readonly kind: "json"; readonly statusCode: number }
	| { readonly frames: AsyncIterable<AuthGatewaySseFrame>; readonly kind: "sse"; readonly statusCode: 200 };

export class AuthGatewayAdapterError extends Error {
	readonly field: string;
	readonly statusCode: number;

	constructor(field: string, statusCode = 400) {
		super(`Unsupported field: ${field}`);
		this.field = field;
		this.statusCode = statusCode;
		this.name = "AuthGatewayAdapterError";
	}
}

export function readRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new AuthGatewayAdapterError("request body");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new AuthGatewayAdapterError(key);
	}
}

export function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) throw new AuthGatewayAdapterError(key);
	return value;
}

export function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new AuthGatewayAdapterError(key);
	return value;
}

export function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new AuthGatewayAdapterError(key);
	return value;
}

export function requiredArray(record: Record<string, unknown>, key: string): readonly unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new AuthGatewayAdapterError(key);
	return value;
}

export function selectorFromHeaders(
	headers: Readonly<Record<string, string | undefined>> | undefined,
): AuthBrokerCredentialSelector | undefined {
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value === undefined || name.toLowerCase() === "authorization") continue;
		if (name !== "x-auth-broker-credential-id" && name !== "x-auth-broker-identity-key") {
			throw new AuthGatewayAdapterError(`header: ${name}`);
		}
	}
	const credentialId = headers?.["x-auth-broker-credential-id"];
	const identityKey = headers?.["x-auth-broker-identity-key"];
	if (credentialId !== undefined && identityKey !== undefined)
		throw new AuthGatewayAdapterError("credential selector");
	if (credentialId !== undefined && credentialId.length > 0) return { credentialId, kind: "credential" };
	if (identityKey !== undefined && identityKey.length > 0) return { identityKey, kind: "identity" };
	return undefined;
}

export function parseToolSchema(value: unknown): TSchema {
	const record = readRecord(value);
	const type = requiredString(record, "type");
	const description = record.description;
	if (description !== undefined && typeof description !== "string")
		throw new AuthGatewayAdapterError("tools.schema.description");
	const options = description === undefined ? {} : { description };
	if (type === "string") return Type.String(options);
	if (type === "number") return Type.Number(options);
	if (type === "integer") return Type.Integer(options);
	if (type === "boolean") return Type.Boolean(options);
	if (type === "array") return Type.Array(parseToolSchema(record.items), options);
	if (type !== "object") throw new AuthGatewayAdapterError("tools.schema.type");
	const properties = record.properties === undefined ? {} : readRecord(record.properties);
	const required = record.required === undefined ? new Set<string>() : schemaRequired(record.required);
	const fields: Record<string, TSchema> = {};
	for (const [name, schema] of Object.entries(properties)) {
		const parsed = parseToolSchema(schema);
		fields[name] = required.has(name) ? parsed : Type.Optional(parsed);
	}
	const additionalProperties = record.additionalProperties;
	if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
		throw new AuthGatewayAdapterError("tools.schema.additionalProperties");
	}
	return Type.Object(fields, { ...options, ...(additionalProperties === undefined ? {} : { additionalProperties }) });
}

function schemaRequired(value: unknown): Set<string> {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new AuthGatewayAdapterError("tools.schema.required");
	}
	return new Set(value);
}

export function unknownModel(): AuthGatewayAdapterResponse {
	return {
		body: { error: { code: "model_not_found", message: "Unknown model", type: "invalid_request_error" } },
		kind: "json",
		statusCode: 404,
	};
}

export function safeError(statusCode: number): AuthGatewayAdapterResponse {
	return {
		body: { error: { message: "Gateway provider unavailable", type: "api_error" } },
		kind: "json",
		statusCode,
	};
}

export function invalidRequest(error: AuthGatewayAdapterError): AuthGatewayAdapterResponse {
	return {
		body: { error: { message: error.message, type: "invalid_request_error" } },
		kind: "json",
		statusCode: error.statusCode,
	};
}
