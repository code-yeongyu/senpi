import { dirname } from "node:path";
import {
	assertConfigValue,
	type ConfigReference,
	ConfigReferenceError,
	type ConfigValue,
} from "@earendil-works/pi-ai/utils/config-reference";
import { warnOpaqueConfigEnvironment } from "./config-reference-env.ts";
import { readConfigReferenceFile } from "./config-reference-file.ts";
import { rememberResolvedReferenceValue } from "./config-reference-redaction.ts";

export interface ConfigReferenceContext {
	readonly origin: string;
	readonly baseDir?: string;
	readonly authority: string;
	readonly field: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

const origins = new WeakMap<ConfigReference, ConfigReferenceContext>();

/** Called at a trusted loader's declared value slots, before any extension merge. */
export function rememberConfigReferenceOrigin(value: ConfigValue, context: ConfigReferenceContext): void {
	if (typeof value !== "string") origins.set(value, context);
}

export function configReferenceContext(
	value: ConfigValue,
	context?: ConfigReferenceContext,
): ConfigReferenceContext | undefined {
	return context ?? (typeof value === "string" ? undefined : origins.get(value));
}

/** A separate preflight lets a caller reject forbidden siblings before any read. */
export function assertConfigReferenceAuthority(value: ConfigValue, context?: ConfigReferenceContext): void {
	if (typeof value === "string") return;
	const source = configReferenceContext(value, context);
	if (source?.authority !== "trusted") {
		throw new ConfigReferenceError(source?.field ?? "configuration value", value, "forbidden");
	}
	assertConfigValue(value, source.field);
}

export async function resolveConfigReference(
	value: ConfigReference,
	context?: ConfigReferenceContext,
	env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
	const source = configReferenceContext(value, context);
	assertConfigReferenceAuthority(value, source);
	// Authority validation establishes this context without assigning a default
	// trusted source to unknown or extension-supplied objects.
	if (source === undefined) throw new ConfigReferenceError("configuration value", value, "forbidden");
	if ("$file" in value) {
		const text = await readConfigReferenceFile({
			field: source.field,
			reference: value,
			baseDir: source.baseDir ?? dirname(source.origin),
		});
		rememberResolvedReferenceValue(text);
		return text;
	}
	if ("$env" in value) {
		const result = (env ?? source.env ?? process.env)[value.$env];
		warnOpaqueConfigEnvironment(value.$env, result);
		if (result === undefined) throw new ConfigReferenceError(source.field, value, "unset");
		if (result === "") throw new ConfigReferenceError(source.field, value, "empty");
		rememberResolvedReferenceValue(result);
		return result;
	}
	const parts: string[] = [];
	for (const part of value.$concat) {
		parts.push(typeof part === "string" ? part : await resolveConfigReference(part, source, env));
	}
	const result = parts.join("");
	if (result === "") throw new ConfigReferenceError(source.field, value, "empty");
	rememberResolvedReferenceValue(result);
	return result;
}
