import { type AnyModel, calculateCost, costCardAt, type Usage } from "@earendil-works/pi-ai";

export interface HandoffEstimate {
	readonly contextTokens: number;
	readonly freshTokens: number;
	readonly nextReplyUsd: number;
	readonly freshUsd: number;
	readonly savingUsd: number;
}

/**
 * Price of sending `tokens` of prompt with no warm cache: a cache write where the model prices one (Anthropic),
 * else plain input (providers whose cache needs no write). Uses the model's own cost card, tiers included.
 */
function coldPromptUsd(model: AnyModel, tokens: number, atMs: number): number {
	const writes = costCardAt(model.cost, atMs).cacheWrite > 0;
	const usage: Usage = {
		input: writes ? 0 : tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: writes ? tokens : 0,
		totalTokens: tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return calculateCost(model, usage, atMs).total;
}

export function estimateHandoff(
	model: AnyModel,
	contextTokens: number,
	freshTokens: number,
	atMs: number,
): HandoffEstimate | undefined {
	const nextReplyUsd = coldPromptUsd(model, contextTokens, atMs);
	if (!(nextReplyUsd > 0)) return undefined;
	const fresh = Math.min(freshTokens, contextTokens);
	const freshUsd = coldPromptUsd(model, fresh, atMs);
	return { contextTokens, freshTokens: fresh, nextReplyUsd, freshUsd, savingUsd: nextReplyUsd - freshUsd };
}

export function formatUsd(value: number): string {
	if (value < 0.01) return "under $0.01";
	return `$${value.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

export function hintText(estimate: HandoffEstimate, subscription: boolean): string {
	// The numbers lead: a one-line banner that clips its tail must still show them.
	const prices = subscription ? " at API prices" : "";
	const plan = subscription ? " On your plan it counts toward your usage limits." : "";
	return (
		`The next reply would cost about ${formatUsd(estimate.nextReplyUsd)}${prices}; ` +
		`a fresh session about ${formatUsd(estimate.freshUsd)}. ` +
		`This session is ${formatTokens(estimate.contextTokens)} tokens and its cache has expired.${plan}`
	);
}
