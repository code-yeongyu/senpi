/**
 * User-facing wording for a ChatGPT sign-in refusal past the plan's usage limit (senpi#3615).
 *
 * Codex CLI sends no flag to spend credits: the backend decides from the account, and when it
 * refuses it explains which limit applies through `x-codex-rate-limit-reached-type` and
 * `x-codex-credits-has-credits` next to the body's `plan_type` and `resets_at` (openai/codex
 * `codex-rs/protocol/src/error.rs`). This mirrors those cases and always ends on a next step. The
 * text keeps the "You have hit your ChatGPT usage limit" opening every usage-limit classifier
 * already matches, and never says "model": a model word would make the fallback layer treat an
 * account-wide limit as one model's limit. Codex's free-form `x-codex-promo-message` is left out
 * for that reason, since its wording is the backend's and can name models.
 */

import { ACCOUNT_LIMIT_NEXT_STEP_LEAD } from "../utils/provider-failure-description.ts";

export const CHATGPT_USAGE_LIMIT_PREFIX = "You have hit your ChatGPT usage limit";

export interface ChatGptUsageLimitInput {
	readonly planType?: string;
	/** Reset as Unix seconds, from the error body. */
	readonly resetsAt?: number;
	readonly header: (name: string) => string | undefined;
	readonly nowMs?: number;
}

const OTHER_ROUTES = `${ACCOUNT_LIMIT_NEXT_STEP_LEAD}add an OpenAI API key, sign in with another ChatGPT account, or switch providers.`;
const USAGE_PAGE = "https://chatgpt.com/settings/usage";

const REACHED_TYPE_ADVICE: Readonly<Record<string, string>> = {
	workspace_owner_credits_depleted: `Your workspace is out of credits: add credits at ${USAGE_PAGE}.`,
	workspace_member_credits_depleted: "Your workspace is out of credits: ask your workspace owner to add more.",
	workspace_owner_usage_limit_reached: "You hit the spend cap set for your workspace: raise it to continue.",
	workspace_member_usage_limit_reached:
		"You hit the spend cap your workspace owner set: ask an owner to raise it to continue.",
};

const PLAN_ADVICE: Readonly<Record<string, string>> = {
	plus: `Upgrade to Pro, or buy credits at ${USAGE_PAGE}.`,
	pro: `Buy credits at ${USAGE_PAGE}.`,
	prolite: `Buy credits at ${USAGE_PAGE}.`,
	promax: `Buy credits at ${USAGE_PAGE}.`,
	free: "Upgrade to ChatGPT Plus to continue.",
	go: "Upgrade to ChatGPT Plus to continue.",
	team: "Ask your workspace admin for more access.",
	business: "Ask your workspace admin for more access.",
	self_serve_business_usage_based: "Ask your workspace admin for more access.",
	enterprise_cbp_usage_based: "Ask your workspace admin for more access.",
};

function headerBool(value: string | undefined): boolean | undefined {
	const raw = value?.trim().toLowerCase();
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return undefined;
}

function limitAdvice(input: ChatGptUsageLimitInput, plan: string | undefined): string | undefined {
	const reachedType = input.header("x-codex-rate-limit-reached-type")?.trim().toLowerCase();
	const reached = reachedType ? REACHED_TYPE_ADVICE[reachedType] : undefined;
	if (reached) return reached;
	if (headerBool(input.header("x-codex-credits-has-credits")) === true) {
		return "This account has ChatGPT credits, but ChatGPT did not apply them to this request.";
	}
	return plan ? PLAN_ADVICE[plan] : undefined;
}

const USAGE_LIMIT_CODE = /usage_limit_reached|usage_not_included/i;
const HTTP_LIMIT_CODE = /usage_limit_reached|usage_not_included|rate_limit_exceeded/i;

interface UsageLimitError {
	readonly code?: unknown;
	readonly type?: unknown;
	readonly plan_type?: unknown;
	readonly resets_at?: unknown;
}

function asUsageLimitError(value: unknown): UsageLimitError | undefined {
	return value !== null && typeof value === "object" ? value : undefined;
}

function fromError(error: UsageLimitError, header: (name: string) => string | undefined): string {
	return describeChatGptUsageLimit({
		...(typeof error.plan_type === "string" ? { planType: error.plan_type } : {}),
		...(typeof error.resets_at === "number" ? { resetsAt: error.resets_at } : {}),
		header,
	});
}

function hasCode(error: UsageLimitError, pattern: RegExp): boolean {
	const code = typeof error.code === "string" && error.code ? error.code : error.type;
	return typeof code === "string" && pattern.test(code);
}

/** HTTP refusal: a usage-limit code or any 429 whose JSON body carries an `error` object. */
export function describeChatGptUsageLimitResponse(status: number, body: unknown, headers: Headers): string | undefined {
	const container = asUsageLimitError(body);
	const error = container ? asUsageLimitError(Reflect.get(container, "error")) : undefined;
	if (!error || !(hasCode(error, HTTP_LIMIT_CODE) || status === 429)) return undefined;
	return fromError(error, (name) => headers.get(name) ?? undefined);
}

/** WebSocket `error` event, which carries the HTTP status and headers inline (openai/codex `WrappedWebsocketErrorEvent`). */
export function describeChatGptUsageLimitEvent(event: Record<string, unknown>): string | undefined {
	const error = asUsageLimitError(event.error);
	if (!error || !hasCode(error, USAGE_LIMIT_CODE)) return undefined;
	const headers = asUsageLimitError(event.headers);
	return fromError(error, (name) => {
		if (!headers) return undefined;
		const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
		return typeof entry?.[1] === "string" ? entry[1] : undefined;
	});
}

export function describeChatGptUsageLimit(input: ChatGptUsageLimitInput): string {
	const plan = input.planType?.trim().toLowerCase() || undefined;
	const sentences = [`${CHATGPT_USAGE_LIMIT_PREFIX}${plan ? ` (${plan} plan)` : ""}.`];
	const advice = limitAdvice(input, plan);
	if (advice) sentences.push(advice);
	sentences.push(OTHER_ROUTES);
	if (input.resetsAt !== undefined && Number.isFinite(input.resetsAt)) {
		const mins = Math.max(0, Math.round((input.resetsAt * 1000 - (input.nowMs ?? Date.now())) / 60000));
		sentences.push(`Try again in ~${mins} min.`);
	}
	return sentences.join(" ");
}
