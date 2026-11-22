import { ConfigReferenceError, type ConfigValue } from "@earendil-works/pi-ai/utils/config-reference";
import { resolveConfigReference } from "../../../config-reference-resolver.ts";
import { hashConfig } from "./config-identity.ts";
import { mcpServerReferences } from "./config-references.ts";
import type { McpServerConfig, McpServerDeclaredConfig, ResolvedMcpServer } from "./config-schema.ts";
import { ConnectError } from "./errors.ts";
import { createMcpLogger } from "./log.ts";
import { inheritMcpSharingScope } from "./sharing-policy.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface McpConfigGeneration {
	readonly config: McpServerConfig;
	readonly configHash: string;
}

export interface McpGenerationScope {
	readonly serverName: string;
	readonly declared: McpServerDeclaredConfig;
	readonly env?: Env;
	readonly agentDir?: string;
}

export interface McpGenerationRenewal {
	readonly resolveConfig: () => Promise<McpServerConfig>;
	readonly changed: () => Promise<boolean>;
}

/** A renewal whose snapshot no longer matches the admitted identity opens no transport; its owners re-key. */
export class McpConfigGenerationChangedError extends ConnectError {
	constructor(serverName: string) {
		super(`MCP server ${serverName} configuration changed; it reconnects under its new identity`, {
			phase: "generation",
			serverName,
		});
		this.name = "McpConfigGenerationChangedError";
	}
}

function resolveValue(value: ConfigValue, env: Env): Promise<string> {
	return typeof value === "string" ? Promise.resolve(value) : resolveConfigReference(value, undefined, env);
}

async function resolveRecord(
	values: Readonly<Record<string, ConfigValue>> | undefined,
	env: Env,
): Promise<Record<string, string> | undefined> {
	if (values === undefined) return undefined;
	const entries = await Promise.all(
		Object.entries(values).map(async ([key, value]): Promise<[string, string]> => [
			key,
			await resolveValue(value, env),
		]),
	);
	return Object.fromEntries(entries);
}

/** One connection generation: every reference resolved into an immutable snapshot, then keyed by it. */
export async function resolveMcpConfigGeneration(scope: McpGenerationScope): Promise<McpConfigGeneration> {
	const env = scope.env ?? process.env;
	const { args: declaredArgs, env: declaredEnv, headers: declaredHeaders, ...fixed } = scope.declared;
	const [args, resolvedEnv, headers] = await Promise.all([
		Promise.all(declaredArgs.map((value) => resolveValue(value, env))),
		resolveRecord(declaredEnv, env),
		resolveRecord(declaredHeaders, env),
	]);
	const config: McpServerConfig = {
		...fixed,
		args,
		...(resolvedEnv === undefined ? {} : { env: resolvedEnv }),
		...(headers === undefined ? {} : { headers }),
	};
	inheritMcpSharingScope(scope.declared, config);
	return { config, configHash: hashConfig(config, scope.agentDir) };
}

/** For a server that declares references: every transport re-reads them, and a changed snapshot re-keys. */
export function mcpGenerationRenewal(
	scope: McpGenerationScope,
	admittedHash: string,
	rekey: () => void,
): McpGenerationRenewal | undefined {
	if (mcpServerReferences(scope.serverName, scope.declared).length === 0) return undefined;
	return {
		resolveConfig: async () => {
			const next = await resolveMcpConfigGeneration(scope);
			if (next.configHash === admittedHash) return next.config;
			rekey();
			throw new McpConfigGenerationChangedError(scope.serverName);
		},
		changed: async () => (await resolveMcpConfigGeneration(scope)).configHash !== admittedHash,
	};
}

/**
 * Resolves every wanted server's generation. A server whose reference fails is recorded in `failures` and
 * removed from `wanted`, so it never connects and never aborts its siblings.
 */
export async function resolveWantedMcpGenerations(
	wanted: Map<string, ResolvedMcpServer>,
	scopeOf: (name: string) => Pick<McpGenerationScope, "env" | "agentDir"> & { readonly logDir?: string },
	failures: Map<string, ConfigReferenceError>,
): Promise<Map<string, McpConfigGeneration>> {
	const generations = new Map<string, McpConfigGeneration>();
	failures.clear();
	await Promise.all(
		[...wanted].map(async ([name, server]) => {
			if (server.config === undefined) return;
			try {
				const generation = await resolveMcpConfigGeneration({
					serverName: name,
					declared: server.config,
					...scopeOf(name),
				});
				// A server that declares no reference keeps its declared identity: re-hashing it under another session's
				// agent dir (a re-sync whose declarer has released) would re-key and respawn an unchanged server.
				const declaredHash = server.configHash;
				generations.set(
					name,
					declaredHash !== undefined && mcpServerReferences(name, server.config).length === 0
						? { config: generation.config, configHash: declaredHash }
						: generation,
				);
				failures.delete(name);
			} catch (error) {
				if (!(error instanceof ConfigReferenceError)) throw error;
				failures.set(name, error);
				createMcpLogger(name, { logDir: scopeOf(name).logDir }).error(error.name, {
					field: error.field,
					reference: error.reference,
					reason: error.reason,
				});
				wanted.delete(name);
			}
		}),
	);
	return generations;
}

/**
 * A connection's identity: the declaration hash (which carries a project server's policy identity) plus the
 * resolved generation hash when resolution changed anything. A server without references keeps its plain hash, so
 * existing keys and cached catalogs stay valid.
 */
export function mcpConnectionIdentity(declared: string, generation: string | undefined): string {
	return generation === undefined || generation === declared ? declared : `${declared}\0${generation}`;
}
