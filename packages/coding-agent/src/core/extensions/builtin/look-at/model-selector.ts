import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../../../cli/args.ts";
import { findExactModelReferenceMatch, parseModelPattern } from "../../../model-resolver.ts";

export const DEFAULT_LOOK_AT_CHAIN = [
	"gpt-5.6-terra:off",
	"gemini-3.1-pro-preview:low",
	"gemini-3.5-flash",
	"kimi-k3",
] as const;

const AMBIGUOUS_ID_PROVIDER_PREFERENCE: readonly string[] = ["openai", "google", "moonshotai"];

export interface ResolvedVisionModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

// pi-ai ThinkingLevel has no "off"; an off/absent suffix must reach callers as undefined.
function normalizeThinkingLevel(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === undefined || level === "off" ? undefined : level;
}

function splitThinkingSuffix(entry: string): { reference: string; thinkingLevel: ThinkingLevel | undefined } {
	const lastColon = entry.lastIndexOf(":");
	if (lastColon === -1) {
		return { reference: entry, thinkingLevel: undefined };
	}
	const suffix = entry.slice(lastColon + 1);
	if (isValidThinkingLevel(suffix)) {
		return { reference: entry.slice(0, lastColon), thinkingLevel: suffix };
	}
	return { reference: entry, thinkingLevel: undefined };
}

function pickProviderForAmbiguousId(candidates: Model<Api>[]): Model<Api> | undefined {
	if (candidates.length === 0) {
		return undefined;
	}
	for (const provider of AMBIGUOUS_ID_PROVIDER_PREFERENCE) {
		const match = candidates.find((model) => model.provider === provider);
		if (match) {
			return match;
		}
	}
	return [...candidates].sort((a, b) => a.provider.localeCompare(b.provider))[0];
}

function resolveEntry(entry: string, visionCandidates: Model<Api>[]): ResolvedVisionModel | undefined {
	const fullExact = findExactModelReferenceMatch(entry, visionCandidates);
	if (fullExact) {
		return { model: fullExact, thinkingLevel: undefined };
	}

	const { reference, thinkingLevel } = splitThinkingSuffix(entry);
	const normalized = normalizeThinkingLevel(thinkingLevel);

	const referenceExact = findExactModelReferenceMatch(reference, visionCandidates);
	if (referenceExact) {
		return { model: referenceExact, thinkingLevel: normalized };
	}

	if (!reference.includes("/")) {
		const wanted = reference.trim().toLowerCase();
		const sameIdCandidates = visionCandidates.filter((model) => model.id.toLowerCase() === wanted);
		if (sameIdCandidates.length > 1) {
			const preferred = pickProviderForAmbiguousId(sameIdCandidates);
			if (preferred) {
				return { model: preferred, thinkingLevel: normalized };
			}
		}
	}

	const parsed = parseModelPattern(reference, visionCandidates);
	if (parsed.model) {
		return { model: parsed.model, thinkingLevel: normalizeThinkingLevel(normalized ?? parsed.thinkingLevel) };
	}
	return undefined;
}

export function resolveVisionModel(
	chain: readonly string[],
	available: readonly Model<Api>[],
): ResolvedVisionModel | undefined {
	const visionCandidates = available.filter((model) => model.input.includes("image"));
	if (visionCandidates.length === 0) {
		return undefined;
	}

	for (const entry of chain) {
		const resolved = resolveEntry(entry, visionCandidates);
		if (resolved) {
			return resolved;
		}
	}

	return { model: visionCandidates[0], thinkingLevel: undefined };
}
