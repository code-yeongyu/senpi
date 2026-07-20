import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "../thinking-levels.ts";
import { baseSelector, parseFallbackSelector } from "./chains.ts";

export interface FallbackModelRegistry {
	find(provider: string, id: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalidSelectorWarning(kind: "key" | "entry", selector: string, key?: string): string {
	const subject =
		kind === "key" ? `Fallback chain key "${selector}"` : `Fallback chain entry "${selector}" for "${key}"`;
	return `${subject} is not a valid or known model selector.`;
}

function validateThinkingLevel(
	selector: { thinkingLevel?: ThinkingLevel; provider: string; id: string },
	model: Model<Api>,
	subject: string,
	warnings: string[],
): void {
	if (selector.thinkingLevel && !getSupportedThinkingLevels(model).includes(selector.thinkingLevel)) {
		warnings.push(
			`${subject} uses thinking level "${selector.thinkingLevel}", which is unsupported by ${selector.provider}/${selector.id}.`,
		);
	}
}

/** Returns configuration warnings without changing malformed fallback-chain settings. */
export function validateFallbackChains(chains: unknown, registry: FallbackModelRegistry): string[] {
	if (!isPlainObject(chains)) return ["Fallback chains must be a plain object."];

	const warnings: string[] = [];
	const models = registry.getAll();

	for (const [key, entries] of Object.entries(chains)) {
		const hasProvider = key.includes("/");
		const hasWildcard = key.includes("*");
		if (!hasProvider) {
			warnings.push(`Fallback chain key "${key}" must use a provider/model selector; roles are unsupported.`);
		}
		if (hasWildcard) warnings.push(`Fallback chain key "${key}" cannot contain wildcards.`);

		const parsedKey = hasProvider && !hasWildcard ? parseFallbackSelector(key, models) : undefined;
		const keyModel = parsedKey ? registry.find(parsedKey.provider, parsedKey.id) : undefined;
		if (hasProvider && !hasWildcard && (!parsedKey || !keyModel)) {
			warnings.push(invalidSelectorWarning("key", key));
		}
		if (parsedKey && keyModel) {
			validateThinkingLevel(parsedKey, keyModel, `Fallback chain key "${key}"`, warnings);
		}

		if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
			warnings.push(`Fallback chain "${key}" entries must be an array of strings.`);
			continue;
		}
		if (entries.length === 0) {
			warnings.push(`Fallback chain "${key}" must contain at least one entry.`);
			continue;
		}

		for (const entry of entries) {
			const parsedEntry = parseFallbackSelector(entry, models);
			const entryModel = parsedEntry ? registry.find(parsedEntry.provider, parsedEntry.id) : undefined;
			if (!parsedEntry || !entryModel) {
				warnings.push(invalidSelectorWarning("entry", entry, key));
				continue;
			}
			if (parsedKey && baseSelector(parsedEntry) === baseSelector(parsedKey)) {
				warnings.push(`Fallback chain entry "${entry}" for "${key}" cannot reference the same model.`);
			}
			validateThinkingLevel(parsedEntry, entryModel, `Fallback chain entry "${entry}"`, warnings);
		}
	}

	return warnings;
}
