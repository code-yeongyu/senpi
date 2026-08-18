import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../../model-registry.ts";
import { SettingsManager } from "../../settings-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext, ServiceTier } from "../types.ts";

export type { ServiceTier };

type ProviderPayload = Record<string, unknown>;

const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
export const CODEX_RESPONSES_API = OPENAI_CODEX_RESPONSES_API;
const FAST_MODEL_SUFFIX = "-fast";
const PRIORITY_TIER: ServiceTier = "priority";
const SERVICE_TIER_APIS: ReadonlySet<Api> = new Set(["openai-responses", OPENAI_CODEX_RESPONSES_API]);
const FAST_ARGUMENTS = ["on", "off"] as const;
const FAST_USAGE = "Usage: /fast [on|off]";

type FastArgument = (typeof FAST_ARGUMENTS)[number];

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

/**
 * The model that owns this model's persisted service-tier preference.
 *
 * A `-fast` catalog variant and its base model are one model to the user (`/fast` just swaps
 * between them), so both must read and write ONE key. Anything else can hold contradictory
 * preferences for the same choice.
 */
export function resolveServiceTierMemoryModel(modelRegistry: ModelRegistry, model: Model<Api>): Model<Api> {
	return findBaseModel(modelRegistry, model) ?? model;
}

/** Remembered service tier for this model, normalized onto its base-model key. */
export function getRememberedServiceTier(
	settingsManager: SettingsManager,
	modelRegistry: ModelRegistry,
	model: Model<Api>,
): ServiceTier | undefined {
	const memoryModel = resolveServiceTierMemoryModel(modelRegistry, model);
	return settingsManager.getModelServiceTier(memoryModel.provider, memoryModel.id);
}

/** Host capabilities `applyFastMode` needs; satisfied by an extension context plus `pi`. */
export interface FastModeContext {
	cwd: string;
	agentDir: string;
	model: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	/** Tier the host resolved for the active model (scoped/favorite pin or catalog). */
	serviceTier: ServiceTier | undefined;
	isProjectTrusted(): boolean;
	notify(message: string, level: "info" | "warning" | "error"): void;
	setSessionModel(model: Model<Api>): Promise<boolean>;
	setSessionFastMode(enabled: boolean): void;
}

export interface FastModeResult {
	/** Fast mode state after the call; unchanged when the request was refused. */
	enabled: boolean;
	/** False when the request was refused (non-Codex model, active pin, failed model switch). */
	applied: boolean;
	/** The just-persisted tier (or the unchanged one when refused); `"priority"` on, `"auto"` off. */
	recordedTier: ServiceTier;
	message: string;
}

/**
 * Whether the active model's priority tier is PINNED by the user's model selection (a scoped
 * or favorite `provider/id:priority` pattern) rather than inherited from the catalog.
 *
 * `ctx.serviceTier` merges both sources, so a priority the catalog does not explain must have
 * come from a `:priority` decorator; checking `scopedModels` alone would miss favorite pins,
 * which the session resolves the same way.
 */
function hasPriorityPin(ctx: FastModeContext, model: Model<Api>): boolean {
	if (ctx.serviceTier !== PRIORITY_TIER) return false;
	return ctx.modelRegistry.getServiceTier(model) !== PRIORITY_TIER;
}

/**
 * Single entry point for turning fast mode on/off: the `/fast` command and any other surface
 * (RPC) must go through this so persistence and `-fast` key normalization exist exactly once.
 *
 * `off` persists an explicit `"auto"` rather than deleting the key: deletion re-inherits the
 * catalog/global tier, which is what the user just asked to turn off.
 */
export async function applyFastMode(ctx: FastModeContext, enabled: boolean): Promise<FastModeResult> {
	const model = ctx.model;
	if (model?.api !== OPENAI_CODEX_RESPONSES_API) {
		const message = "Fast mode is only available for OpenAI Codex models.";
		ctx.notify(message, "warning");
		return { enabled: false, applied: false, recordedTier: "auto", message };
	}

	if (!enabled && hasPriorityPin(ctx, model)) {
		// The pin outranks the memory, so writing "auto" here would be a silent no-op on the wire.
		const message = "Fast mode is fixed by the active model selection's priority tier.";
		ctx.notify(message, "info");
		// The pin keeps the model on priority no matter what the memory says, so that is the honest
		// tier to report; nothing was written, and no caller reads this field when `applied` is false.
		return { enabled: true, applied: false, recordedTier: PRIORITY_TIER, message };
	}

	const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });
	const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, model);
	const tier: ServiceTier = enabled ? PRIORITY_TIER : "auto";
	settingsManager.setModelServiceTier(memoryModel.provider, memoryModel.id, tier);
	await settingsManager.flush();

	const baseModel = findBaseModel(ctx.modelRegistry, model);
	const targetModel = enabled ? findFastModel(ctx.modelRegistry, model) : baseModel;
	if (targetModel) {
		if (!(await ctx.setSessionModel(targetModel))) {
			const message = `Could not switch to ${targetModel.provider}/${targetModel.id}.`;
			ctx.notify(message, "error");
			return { enabled: baseModel === undefined, applied: false, recordedTier: "auto", message };
		}
	}

	ctx.setSessionFastMode(enabled);
	const labelModel = targetModel ?? model;
	const message = `Fast mode ${enabled ? "enabled" : "disabled"}: ${labelModel.id}`;
	ctx.notify(message, "info");
	return { enabled, applied: true, recordedTier: tier, message };
}

function toCompletions(values: readonly string[], prefix: string): AutocompleteItem[] | null {
	const matches = values.filter((value) => value.startsWith(prefix.trim()));
	return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
}

function toFastModeContext(pi: ExtensionAPI, ctx: ExtensionCommandContext): FastModeContext {
	return {
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		serviceTier: ctx.serviceTier,
		isProjectTrusted: () => ctx.isProjectTrusted(),
		notify: (message, level) => ctx.ui.notify(message, level),
		setSessionModel: (model) => pi.setSessionModel(model),
		setSessionFastMode: (enabled) => pi.setSessionFastMode(enabled),
	};
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
	/**
	 * The per-model memory tier `/fast` last wrote or read for the active base model this
	 * session. Lives only to suppress an inherited priority when the user turns fast off in
	 * the SAME session: the host's resolved `ctx.serviceTier` is recomputed on model switch,
	 * not on a memory write, so without this an in-session `/fast off` (no model swap) would
	 * keep sending `priority` until a restart. Scoped to the active base key (re-derived on
	 * model_select for the incoming model) so it never leaks across models.
	 */
	let liveMemoryTier: ServiceTier | undefined;
	let liveMemoryKey: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });
		settingsServiceTier = settingsManager.getOpenAIServiceTier();

		const model = ctx.model;
		if (model?.api !== OPENAI_CODEX_RESPONSES_API) {
			sessionFastMode = false;
			pi.setSessionFastMode(false);
			return;
		}

		// Fast mode is remembered per model, so a new session inherits the user's last choice for
		// THIS model instead of silently starting off. A model whose catalog/scoped tier is already
		// `priority` (a models.json priority entry, or a `-fast`-less codex model) is treated as
		// fast-active when nothing is remembered; an explicit remembered `"auto"` (`/fast off`)
		// wins over that inheritance. Malformed values read back as undefined.
		//
		// The flag is derived from the POST-swap model: a `-fast` catalog variant swaps down to
		// its base before this reads `ctx.serviceTier`, so inheritance is judged on the model the
		// user actually ends up on.
		const remembered = getRememberedServiceTier(settingsManager, ctx.modelRegistry, model);

		const baseModel = findBaseModel(ctx.modelRegistry, model);
		if (baseModel) {
			await pi.setSessionModel(baseModel);
		}

		sessionFastMode = remembered === PRIORITY_TIER || (remembered === undefined && ctx.serviceTier === PRIORITY_TIER);
		pi.setSessionFastMode(sessionFastMode);
		const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, model);
		liveMemoryKey = `${memoryModel.provider}/${memoryModel.id}`;
		liveMemoryTier = remembered;
	});

	pi.on("model_select", (event, ctx) => {
		// A model switch changes the base key the memory lives under, so the live tier is RE-DERIVED
		// for the incoming model instead of merely dropped: dropping it would leave a remembered
		// "auto" unable to suppress a catalog-inherited priority after switching away and back in one
		// session, silently re-sending the tier `/fast off` turned off. Per-key scoping is preserved —
		// each model reads ITS OWN memory, never the previous model's.
		const settingsManager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });
		const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, event.model);
		liveMemoryKey = `${memoryModel.provider}/${memoryModel.id}`;
		liveMemoryTier = getRememberedServiceTier(settingsManager, ctx.modelRegistry, event.model);
	});

	pi.registerCommand("fast", {
		description: "Turn OpenAI Codex fast mode on or off for the current model",
		argumentHint: "[on|off]",
		getArgumentCompletions: (prefix) => toCompletions(FAST_ARGUMENTS, prefix),
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument !== "" && !FAST_ARGUMENTS.includes(argument as FastArgument)) {
				ctx.ui.notify(FAST_USAGE, "error");
				return;
			}

			// No argument keeps the established toggle UX.
			const active = sessionFastMode || ctx.serviceTier === PRIORITY_TIER;
			const enabled = argument === "" ? !active : argument === "on";
			const result = await applyFastMode(toFastModeContext(pi, ctx), enabled);
			sessionFastMode = result.enabled;
			// Track this session's own write AFTER applyFastMode's internal model switch (which fires
			// model_select and clears the live tier). Keyed to the active base model so a later switch
			// cannot carry it across models.
			if (result.applied && ctx.model) {
				const memoryModel = resolveServiceTierMemoryModel(ctx.modelRegistry, ctx.model);
				liveMemoryKey = `${memoryModel.provider}/${memoryModel.id}`;
				liveMemoryTier = result.recordedTier;
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		let effectiveServiceTier: ServiceTier | undefined;
		if (ctx.model?.api === OPENAI_CODEX_RESPONSES_API) {
			if (sessionFastMode) {
				effectiveServiceTier = PRIORITY_TIER;
			} else {
				const memoryModel = ctx.model ? resolveServiceTierMemoryModel(ctx.modelRegistry, ctx.model) : undefined;
				const activeBaseKey = memoryModel ? `${memoryModel.provider}/${memoryModel.id}` : undefined;
				// Same-session /fast off: the host's resolved ctx.serviceTier is only recomputed on a
				// model switch, so an inherited priority would otherwise keep emitting until a restart.
				// Only a CATALOG-explained priority may be suppressed: a priority the catalog does not
				// explain is an explicit scoped/favorite `:priority` pin, which outranks the memory
				// (same discriminator `applyFastMode` uses to refuse `/fast off` under a pin).
				const catalogExplainsPriority =
					ctx.model !== undefined && ctx.modelRegistry.getServiceTier(ctx.model) === PRIORITY_TIER;
				if (
					liveMemoryTier === "auto" &&
					activeBaseKey === liveMemoryKey &&
					ctx.serviceTier === PRIORITY_TIER &&
					catalogExplainsPriority
				) {
					effectiveServiceTier = undefined;
				} else {
					effectiveServiceTier = ctx.serviceTier;
				}
			}
		} else {
			effectiveServiceTier = ctx.serviceTier ?? settingsServiceTier;
		}
		return addServiceTierToPayload(ctx.model?.api, event.payload, effectiveServiceTier);
	});
}
