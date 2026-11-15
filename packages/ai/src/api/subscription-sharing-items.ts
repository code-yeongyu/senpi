const SHARED_SUBSCRIPTION_ITEM_LIMIT_MARKER = "User subscription sharing currently supports only";

export function isSharedSubscriptionItemLimitMessage(message: string): boolean {
	return message.includes(SHARED_SUBSCRIPTION_ITEM_LIMIT_MARKER);
}

export function sharedSubscriptionItemLimitMessage(provider: string, original: string): string {
	return `${original} (${provider} rejected the tool-call items this session replays under subscription sharing; switch this session to a model whose route accepts tool calls)`;
}
