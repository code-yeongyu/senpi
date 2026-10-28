/**
 * Which upstream vendor serves a model, and which vendor a failure names, so a usage
 * limit or billing failure on a gateway provider (one provider name routing to
 * several vendors' accounts) holds only the upstream that failed (senpi#4577).
 * Unknown stays undefined: the caller then keeps the account-wide hold.
 */
const UPSTREAMS = [
	{
		name: "anthropic",
		named: /\banthropic\b/i,
		family: /(?:^|[^a-z])(?:claude|opus|sonnet|haiku|fable|mythos)(?:[^a-z]|$)/i,
	},
	{ name: "openai", named: /\bopenai\b/i, family: /(?:^|[^a-z])(?:gpt|chatgpt|codex|o\d)(?:[^a-z]|$)/i },
] as const;

/** The vendor behind a model id: its `vendor/` prefix when it names a known vendor, else its family name. */
export function modelUpstream(modelId: string): string | undefined {
	const slash = modelId.indexOf("/");
	const prefix = slash > 0 ? modelId.slice(0, slash).toLowerCase() : undefined;
	const byPrefix = UPSTREAMS.find((upstream) => upstream.name === prefix);
	return (byPrefix ?? UPSTREAMS.find((upstream) => upstream.family.test(modelId)))?.name;
}

/** The one vendor a failure text names ("...access the Anthropic API"); undefined when it names none or several. */
export function failureUpstream(errorMessage: string): string | undefined {
	const named = UPSTREAMS.filter((upstream) => upstream.named.test(errorMessage));
	return named.length === 1 ? named[0]?.name : undefined;
}
