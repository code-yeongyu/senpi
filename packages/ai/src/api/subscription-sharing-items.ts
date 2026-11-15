import type { Api, Model } from "../types.ts";

const SHARED_SUBSCRIPTION_PROVIDER = "chatgpt-subscription";

const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
]);

export type ResponsesInputItem = { readonly type?: string | null };

export class SharedSubscriptionToolItemsError extends Error {
	readonly code = "subscription_sharing_unsupported_input_item";

	constructor(modelId: string, types: readonly string[]) {
		super(
			`Subscription sharing supports only text, image, and file messages: chatgpt-subscription cannot send ${types.join(", ")} items for ${modelId}; run tool sessions on a model whose provider supports function-call items`,
		);
		this.name = "SharedSubscriptionToolItemsError";
	}
}

export function assertNoSharedSubscriptionToolItems(model: Model<Api>, items: readonly ResponsesInputItem[]): void {
	if (model.provider !== SHARED_SUBSCRIPTION_PROVIDER) return;
	const types = [
		...new Set(
			items.flatMap((item) =>
				item.type !== undefined && item.type !== null && TOOL_ITEM_TYPES.has(item.type) ? [item.type] : [],
			),
		),
	];
	if (types.length > 0) throw new SharedSubscriptionToolItemsError(model.id, types);
}
