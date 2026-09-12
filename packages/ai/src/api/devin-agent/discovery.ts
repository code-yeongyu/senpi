/**
 * Cascade model discovery.
 *
 * `GetCliModelConfigs` is credential-scoped: it reports the models the signed-in
 * account may actually use, which differs per plan and per rollout. A failed or
 * empty response therefore returns undefined so callers KEEP their static seed
 * instead of publishing an empty catalog.
 */

import type { Model } from "../../types.ts";
import {
	type ClientModelConfig,
	DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	ModelDimensionKind,
} from "./gen/cascade_pb.ts";
import { devinDiscoveryMetadata } from "./metadata.ts";
import { DEVIN_CLI_MODEL_CONFIGS_PATH, DEVIN_DEFAULT_BASE_URL } from "./paths.ts";
import { postDevinUnary } from "./unary.ts";

const DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/** Slots requested for parity with the native client but never surfaced as models. */
const INTERNAL_DISPLAYS: ReadonlySet<DisplayOption> = new Set([
	DisplayOption.QUICK_REVIEW,
	DisplayOption.INTERNAL_DEFAULT,
]);

/**
 * Lanes whose configs advertise image support while the backend silently drops
 * `ChatMessagePrompt.images` (verified live on SWE-1.6 and SWE-1.6 Fast).
 */
const IMAGE_BLIND_UIDS: ReadonlySet<string> = new Set(["swe-1-6", "swe-1-6-fast"]);

const REASONING_LABEL = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL = /\bno thinking\b/i;

export interface DevinDiscoveryOptions {
	apiKey: string | undefined;
	baseUrl?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function fetchDevinModels(options: DevinDiscoveryOptions): Promise<Model<"devin-agent">[] | undefined> {
	const baseUrl = (options.baseUrl ?? DEVIN_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);

	try {
		const response = await postDevinUnary({
			baseUrl,
			path: DEVIN_CLI_MODEL_CONFIGS_PATH,
			requestSchema: GetCliModelConfigsRequestSchema,
			request: { metadata: devinDiscoveryMetadata(options.apiKey) },
			responseSchema: GetCliModelConfigsResponseSchema,
			signal: controller.signal,
		});
		const models = normalizeDevinModels(response.clientModelConfigs, baseUrl);
		return models.length > 0 ? models : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export function normalizeDevinModels(configs: readonly ClientModelConfig[], baseUrl: string): Model<"devin-agent">[] {
	const seen = new Set<string>();
	const models: Model<"devin-agent">[] = [];
	for (const config of configs) {
		if (config.disabled) continue;
		const display = config.modelInfo?.displayOption ?? DisplayOption.UNSPECIFIED;
		if (INTERNAL_DISPLAYS.has(display)) continue;
		const uid = config.modelUid.trim();
		if (!uid || seen.has(uid)) continue;
		seen.add(uid);
		const isRouter = display === DisplayOption.MODEL_ROUTER || config.modelInfo?.isModelRouter === true;
		models.push(toModel(config, uid, baseUrl, isRouter));
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}

function toModel(config: ClientModelConfig, uid: string, baseUrl: string, isRouter: boolean): Model<"devin-agent"> {
	const features = config.modelInfo?.modelFeatures;
	const supportsImages = (features ? features.supportsImages : config.supportsImages) && !IMAGE_BLIND_UIDS.has(uid);
	const maxOutputTokens = config.modelInfo?.maxOutputTokens ?? 0;
	const compat = {
		...(isRouter ? { modelRouter: true } : {}),
		...(features?.supportsParallelToolCalls === true ? { supportsParallelToolCalls: true } : {}),
	};
	return {
		id: uid,
		name: config.label.trim() || uid,
		api: "devin-agent",
		provider: "devin",
		baseUrl,
		reasoning: supportsThinking(config),
		input: supportsImages ? ["text", "image"] : ["text"],
		cost: costOf(config),
		contextWindow: config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW,
		maxTokens: maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_TOKENS,
		...(Object.keys(compat).length > 0 ? { compat } : {}),
	};
}

function supportsThinking(config: ClientModelConfig): boolean {
	const features = config.modelInfo?.modelFeatures;
	if (features !== undefined) return features.supportsThinking;
	if (NO_REASONING_LABEL.test(config.label)) return false;
	return REASONING_LABEL.test(config.label);
}

/** Per-million rates from the cost dimensions; Devin bills cache writes at the input rate, so cacheWrite stays 0. */
function costOf(config: ClientModelConfig): Model<"devin-agent">["cost"] {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const dimension of config.modelDimensions) {
		if (dimension.kind !== ModelDimensionKind.COST && dimension.kind !== ModelDimensionKind.COST_FUZZY) continue;
		// Dimension values arrive as protobuf floats (0.1 decodes as 0.10000000149…); round at sub-cent precision.
		const perMillion =
			Math.round(((dimension.value * 1_000_000) / denominatorTokens(dimension.denominator)) * 1e6) / 1e6;
		switch (dimension.label.trim().toLowerCase()) {
			case "input":
				cost.input = perMillion;
				break;
			case "cached input":
				cost.cacheRead = perMillion;
				break;
			case "output":
				cost.output = perMillion;
				break;
			default:
				break;
		}
	}
	return cost;
}

const DENOMINATOR_SCALE: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

function denominatorTokens(denominator: string): number {
	const match = /(\d+(?:\.\d+)?)\s*([kmb])?/i.exec(denominator);
	if (!match?.[1]) return 1_000_000;
	const scale = match[2] ? (DENOMINATOR_SCALE[match[2].toLowerCase()] ?? 1) : 1;
	const tokens = Number(match[1]) * scale;
	return tokens > 0 ? tokens : 1_000_000;
}
