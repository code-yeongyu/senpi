import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../model-registry.ts";
import { SettingsManager } from "../../settings-manager.ts";
import type { ExtensionAPI, ServiceTier } from "../types.ts";

export type { ServiceTier };

type ProviderPayload = Record<string, unknown>;

const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const FAST_MODEL_SUFFIX = "-fast";
const PRIORITY_TIER: ServiceTier = "priority";
const SERVICE_TIER_APIS: ReadonlySet<Api> = new Set(["openai-responses", OPENAI_CODEX_RESPONSES_API]);

function isRecord(value: unknown): value is ProviderPayload {
	return typeof value === "object" && value !== null;
}

export function addServiceTierToPayload(api: Api | undefined, payload: unknown, serviceTier?: ServiceTier): unknown {
	if (!api || !SERVICE_TIER_APIS.has(api) || !serviceTier) {
		return payload;
	}

	if (!isRecord(payload) || payload.service_tier !== undefined) {
		return payload;
	}

	return {
		...payload,
		service_tier: serviceTier,
	};
}

function getRequestModelId(modelRegistry: ModelRegistry, model: Model<Api>): string {
	return modelRegistry.getUpstreamModelId(model) ?? model.id;
}

function isCompatibleFastVariant(modelRegistry: ModelRegistry, baseModel: Model<Api>, fastModel: Model<Api>): boolean {
	return (
		fastModel.provider === baseModel.provider &&
		fastModel.api === baseModel.api &&
		modelRegistry.getServiceTier(fastModel) === "priority" &&
		getRequestModelId(modelRegistry, fastModel) === getRequestModelId(modelRegistry, baseModel)
	);
}

function findBaseModel(modelRegistry: ModelRegistry, fastModel: Model<Api>): Model<Api> | undefined {
	if (!fastModel.id.endsWith(FAST_MODEL_SUFFIX)) {
		return undefined;
	}

	const baseModelId = fastModel.id.slice(0, -FAST_MODEL_SUFFIX.length);
	const baseModel = modelRegistry.find(fastModel.provider, baseModelId);
	return baseModel && isCompatibleFastVariant(modelRegistry, baseModel, fastModel) ? baseModel : undefined;
}

function findFastModel(modelRegistry: ModelRegistry, baseModel: Model<Api>): Model<Api> | undefined {
	if (baseModel.id.endsWith(FAST_MODEL_SUFFIX)) {
		return undefined;
	}

	const fastModel = modelRegistry.find(baseModel.provider, `${baseModel.id}${FAST_MODEL_SUFFIX}`);
	return fastModel && isCompatibleFastVariant(modelRegistry, baseModel, fastModel) ? fastModel : undefined;
}

export default function serviceTierExtension(pi: ExtensionAPI): void {
	let settingsServiceTier: ServiceTier | undefined;
	/**
	 * Session-level fast mode for Codex models that have no `-fast` catalog sibling.
	 *
	 * The catalog generator emits `-fast` priority variants only for the direct
	 * `openai` provider, so `openai-codex` models never have a switch target. The
	 * ChatGPT backend still offers the tier to subscriptions:
	 * `chatgpt.com/backend-api/codex/models` advertises a `priority` service tier
	 * labelled "Fast" ("1.5x speed, increased usage")
	 * for gpt-5.4/5.5/5.6-*, and the first-party Codex CLI sends
	 * `service_tier: "priority"` on subscription OAuth. The response echo is not a
	 * confirmation channel — it reads `auto`/`default` whether or not a tier was
	 * sent — so this toggle drives the request field directly. See issue #545.
	 */
	let sessionFastMode = false;

	pi.on("session_start", async (_event, ctx) => {
		const settingsManager = SettingsManager.create(ctx.cwd);
		settingsServiceTier = settingsManager.getOpenAIServiceTier();
		sessionFastMode = false;
		pi.setSessionFastMode(false);

		const model = ctx.model;
		if (model?.api !== OPENAI_CODEX_RESPONSES_API) {
			return;
		}

		const baseModel = findBaseModel(ctx.modelRegistry, model);
		if (baseModel) {
			await pi.setSessionModel(baseModel);
		}
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex fast mode for this session",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (model?.api !== OPENAI_CODEX_RESPONSES_API) {
				ctx.ui.notify("Fast mode is only available for OpenAI Codex models.", "warning");
				return;
			}

			const baseModel = findBaseModel(ctx.modelRegistry, model);
			const targetModel = baseModel ?? findFastModel(ctx.modelRegistry, model);
			if (!targetModel) {
				sessionFastMode = !sessionFastMode;
				pi.setSessionFastMode(sessionFastMode);
				ctx.ui.notify(`Fast mode ${sessionFastMode ? "enabled" : "disabled"}: ${model.id}`, "info");
				return;
			}

			if (!(await pi.setSessionModel(targetModel))) {
				ctx.ui.notify(`Could not switch to ${targetModel.provider}/${targetModel.id}.`, "error");
				return;
			}

			const enabled = baseModel === undefined;
			ctx.ui.notify(`Fast mode ${enabled ? "enabled" : "disabled"}: ${targetModel.id}`, "info");
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		const effectiveServiceTier =
			ctx.model?.api === OPENAI_CODEX_RESPONSES_API
				? (ctx.serviceTier ?? (sessionFastMode ? PRIORITY_TIER : undefined))
				: (ctx.serviceTier ?? settingsServiceTier);
		return addServiceTierToPayload(ctx.model?.api, event.payload, effectiveServiceTier);
	});
}
