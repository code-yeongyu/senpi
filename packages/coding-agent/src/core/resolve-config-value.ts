/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import type { ConfigValue } from "@earendil-works/pi-ai/utils/config-reference";
import { warnMissingConfigEnvironment, warnOpaqueConfigEnvironment } from "./config-reference-env.ts";
import {
	assertConfigReferenceAuthority,
	type ConfigReferenceContext,
	resolveConfigReference,
} from "./config-reference-resolver.ts";
import { runConfigCommand } from "./resolve-config-command.ts";

// Cache for shell command results (persists for process lifetime). The in-flight
// promise is what is cached, so concurrent sessions resolving the same command share
// one execution instead of racing their own.
const commandResultCache = new Map<string, Promise<string | undefined>>();

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	const value = env?.[name] || process.env[name] || undefined;
	warnOpaqueConfigEnvironment(name, value);
	return value;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) {
			warnMissingConfigEnvironment(part.name);
			return undefined;
		}
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarName(config: ConfigValue): string | undefined {
	if (typeof config !== "string") return "$env" in config ? config.$env : undefined;
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

export function getConfigValueEnvVarNames(config: ConfigValue): string[] {
	if (typeof config !== "string") {
		if ("$env" in config) return [config.$env];
		return "$concat" in config
			? [
					...new Set(
						config.$concat.flatMap((part) => (typeof part !== "string" && "$env" in part ? [part.$env] : [])),
					),
				]
			: [];
	}
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: ConfigValue, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: ConfigValue): boolean {
	return typeof config === "string" && parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: ConfigValue, env?: Record<string, string>): boolean {
	return typeof config !== "string" || getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(
	config: ConfigValue,
	env?: Record<string, string>,
	context?: ConfigReferenceContext,
): Promise<string | undefined> {
	if (typeof config !== "string") return resolveConfigReference(config, context, env);
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		// Credentials can carry a per-session environment. Those commands must not
		// reuse a process-wide result produced under another session's environment.
		return env === undefined ? executeCommand(reference.config) : runConfigCommand(reference.config, env);
	}
	return Promise.resolve(resolveTemplate(reference.parts, env));
}

function executeCommand(commandConfig: string): Promise<string | undefined> {
	const cached = commandResultCache.get(commandConfig);
	if (cached) return cached;

	const result = runConfigCommand(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(
	config: ConfigValue,
	env?: Record<string, string>,
	context?: ConfigReferenceContext,
): Promise<string | undefined> {
	if (typeof config !== "string") return resolveConfigReference(config, context, env);
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return runConfigCommand(reference.config, env);
	}
	return Promise.resolve(resolveTemplate(reference.parts, env));
}

export async function resolveConfigValueOrThrow(
	config: ConfigValue,
	description: string,
	env?: Record<string, string>,
	context?: ConfigReferenceContext,
): Promise<string> {
	if (typeof config !== "string") return resolveConfigReference(config, context, env);
	const resolvedValue = await resolveConfigValueUncached(config, env, context);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	throw new Error(`Failed to resolve ${description}`);
}

export async function resolveHeadersOrThrow(
	headers: Record<string, ConfigValue> | undefined,
	description: string,
	env?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	for (const value of Object.values(headers)) assertConfigReferenceAuthority(value);
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = await resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
