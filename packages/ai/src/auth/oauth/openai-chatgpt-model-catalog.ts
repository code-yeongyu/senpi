import { CHATGPT_SUBSCRIPTION_MODELS } from "../../providers/chatgpt-subscription.models.ts";
import type { Model } from "../../types.ts";
import { ModelsError } from "../../utils/models-error.ts";

/** Verified identity, not email, slot label, or a rotating bearer token. */
export interface OpenAIChatGptModelIdentity {
	sub: string;
	clientId: string;
}

export interface OpenAIChatGptModelAccount extends OpenAIChatGptModelIdentity {
	/** Supply the access token after the runtime's shared OAuth refresh has completed. */
	access: string;
}

/**
 * Picker entries are not full inference Models: /v1/models supplies no capability
 * metadata for unknown slugs. W11's slot adapter must preserve that distinction.
 */
export type OpenAIChatGptCatalogModel = Pick<Model<"openai-responses">, "id" | "name"> &
	Partial<
		Pick<
			Model<"openai-responses">,
			"contextWindow" | "maxTokens" | "reasoning" | "thinkingLevelMap" | "input" | "cost"
		>
	>;

export class OpenAIChatGptModelCatalogError extends ModelsError {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super("model_source", message);
		this.name = "OpenAIChatGptModelCatalogError";
		this.status = status;
	}
}

function identityKey(identity: OpenAIChatGptModelIdentity): string {
	return JSON.stringify([identity.sub, identity.clientId]);
}

function parseCatalog(raw: unknown): OpenAIChatGptCatalogModel[] {
	const models = raw && typeof raw === "object" && "models" in raw ? raw.models : undefined;
	if (!Array.isArray(models)) {
		throw new OpenAIChatGptModelCatalogError("Invalid SIWC models response");
	}
	return models.flatMap((item: unknown): OpenAIChatGptCatalogModel[] => {
		if (!item || typeof item !== "object" || !("visibility" in item) || item.visibility !== "list") return [];
		if (
			!("slug" in item) ||
			typeof item.slug !== "string" ||
			!item.slug ||
			!("display_name" in item) ||
			typeof item.display_name !== "string" ||
			!item.display_name
		) {
			throw new OpenAIChatGptModelCatalogError("Invalid listed SIWC model");
		}
		const known = Object.values(CHATGPT_SUBSCRIPTION_MODELS).find((model) => model.id === item.slug);
		return [
			{
				id: item.slug,
				name: item.display_name,
				...(known
					? {
							contextWindow: known.contextWindow,
							maxTokens: known.maxTokens,
							reasoning: known.reasoning,
							...(known.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
							input: known.input,
							cost: known.cost,
						}
					: {}),
			},
		];
	});
}

/**
 * Last-known, account-scoped catalogs with transactional refresh, like provider
 * refreshModels. This owns neither OAuth refresh nor provider registration.
 * Keep one instance per provider runtime; activate the selected slot on account
 * changes, or call refresh after explicit model refresh/token renewal.
 */
export class OpenAIChatGptModelCatalog {
	private readonly catalogs = new Map<string, readonly OpenAIChatGptCatalogModel[]>();
	private readonly generations = new Map<string, number>();
	private activeKey?: string;
	private activeNeedsRefresh = true;

	getModels(identity?: OpenAIChatGptModelIdentity): readonly OpenAIChatGptCatalogModel[] {
		const key = identity ? identityKey(identity) : this.activeKey;
		return key === undefined ? [] : (this.catalogs.get(key) ?? []);
	}

	async activate(
		account: OpenAIChatGptModelAccount,
		signal: AbortSignal,
	): Promise<readonly OpenAIChatGptCatalogModel[]> {
		const key = identityKey(account);
		if (key !== this.activeKey) {
			this.activeKey = key;
			this.activeNeedsRefresh = true;
		}
		if (!this.activeNeedsRefresh) return this.getModels(account);
		const models = await this.refresh(account, signal);
		if (this.activeKey === key) this.activeNeedsRefresh = false;
		return models;
	}

	async refresh(
		account: OpenAIChatGptModelAccount,
		signal: AbortSignal,
	): Promise<readonly OpenAIChatGptCatalogModel[]> {
		signal.throwIfAborted();
		const key = identityKey(account);
		const generation = (this.generations.get(key) ?? 0) + 1;
		this.generations.set(key, generation);
		const response = await fetch("https://api.openai.com/v1/models", {
			method: "GET",
			headers: { Authorization: `Bearer ${account.access}` },
			signal,
		});
		if (!response.ok) {
			throw new OpenAIChatGptModelCatalogError(
				`SIWC model catalog request failed (HTTP ${response.status})`,
				response.status,
			);
		}
		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			throw new OpenAIChatGptModelCatalogError("Invalid SIWC models response");
		}
		const models = parseCatalog(raw);
		signal.throwIfAborted();
		if (this.generations.get(key) === generation) this.catalogs.set(key, models);
		return models;
	}
}
