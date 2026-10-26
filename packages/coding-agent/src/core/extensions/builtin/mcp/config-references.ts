import {
	type ConfigReference,
	ConfigReferenceError,
	isConfigReference,
} from "@earendil-works/pi-ai/utils/config-reference";
import { rememberConfigReferenceOrigin } from "../../../config-reference-resolver.ts";
import type { McpServerConfig, McpServerDeclaration, McpServerDeclaredConfig } from "./config-schema.ts";

export interface McpServerReference {
	readonly field: string;
	readonly reference: ConfigReference;
}

/** The accepting positions of one declared server: `headers.*`, `env.*` and `args[]`. */
export function mcpServerReferences(name: string, server: McpServerDeclaration): McpServerReference[] {
	const found: McpServerReference[] = [];
	const visit = (value: unknown, field: string) => {
		if (isConfigReference(value)) found.push({ field: `mcpServers.${name}.${field}`, reference: value });
	};
	for (const [key, value] of Object.entries(server.headers ?? {})) visit(value, `headers.${key}`);
	for (const [key, value] of Object.entries(server.env ?? {})) visit(value, `env.${key}`);
	for (const [index, value] of (server.args ?? []).entries()) visit(value, `args.${index}`);
	return found;
}

/** Called as a trusted file is read, so each reference resolves against the file that declares it. */
export function rememberMcpReferenceOrigins(
	servers: Readonly<Record<string, McpServerDeclaration>> | undefined,
	origin: string,
): void {
	for (const [name, server] of Object.entries(servers ?? {})) {
		for (const { field, reference } of mcpServerReferences(name, server)) {
			rememberConfigReferenceOrigin(reference, { origin, authority: "trusted", field });
		}
	}
}

/** A source that does not expand legacy `${NAME}` refuses every reference before any I/O. */
export function refuseMcpReferences(name: string, server: McpServerDeclaration): void {
	const [first] = mcpServerReferences(name, server);
	if (first !== undefined) throw new ConfigReferenceError(first.field, first.reference, "forbidden");
}

/** A declaration whose accepting positions hold plain strings: a source that refuses reference objects. */
export type PlainMcpServerDeclaration = Omit<McpServerDeclaration, "args" | "env" | "headers"> & {
	args?: string[];
	env?: Record<string, string>;
	headers?: Record<string, string>;
};

const strings = (record: Readonly<Record<string, unknown>>): Record<string, string> =>
	Object.fromEntries(
		Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);

/** Refuses the first reference with its named error, then narrows the declaration to plain strings. */
export function plainMcpDeclaration(name: string, server: McpServerDeclaration): PlainMcpServerDeclaration {
	refuseMcpReferences(name, server);
	const { args, env, headers, ...rest } = server;
	return {
		...rest,
		...(args === undefined ? {} : { args: args.filter((arg): arg is string => typeof arg === "string") }),
		...(env === undefined ? {} : { env: strings(env) }),
		...(headers === undefined ? {} : { headers: strings(headers) }),
	};
}

/** The normalized form of a plain declaration, as a connection config (no reference left to resolve). */
export function plainMcpServerConfig(name: string, server: McpServerDeclaredConfig): McpServerConfig {
	refuseMcpReferences(name, server);
	const { args, env, headers, ...rest } = server;
	return {
		...rest,
		args: args.filter((arg): arg is string => typeof arg === "string"),
		...(env === undefined ? {} : { env: strings(env) }),
		...(headers === undefined ? {} : { headers: strings(headers) }),
	};
}
