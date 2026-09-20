import { z } from "zod";
import type { RotationSlot, RotationSources } from "./rotation-stream.ts";

const windowSchema = z.object({
	used_percent: z.number().nonnegative(),
	reset_at: z.number().nonnegative().optional(),
});
const limitSchema = z.object({
	allowed: z.boolean(),
	limit_reached: z.boolean(),
	primary_window: windowSchema.nullable(),
	secondary_window: windowSchema.nullable().optional(),
});
const usageSchema = z.object({
	rate_limit: limitSchema,
	additional_rate_limits: z
		.array(
			z.object({
				normal_model_slug: z.string().optional(),
				rate_limit: limitSchema,
			}),
		)
		.nullable()
		.optional(),
	credits: z
		.object({
			has_credits: z.boolean(),
			unlimited: z.boolean().optional(),
			overage_limit_reached: z.boolean().optional(),
			balance: z.union([z.string(), z.number()]).nullable().optional(),
		})
		.nullable()
		.optional(),
});

/**
 * Read-only quota admission. Token resolution remains owned by ModelRuntime,
 * including its file-locked OAuth refresh. Never persist a token or WHAM body.
 */
export async function fetchCodexUsage(token: string | undefined, signal?: AbortSignal): Promise<unknown> {
	if (!token) throw new Error("Codex quota admission unavailable: missing OAuth credential");
	const claims = z
		.object({ "https://api.openai.com/auth": z.object({ chatgpt_account_id: z.string().optional() }).optional() })
		.parse(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()));
	const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
	const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			...(accountId ? { "chatgpt-account-id": accountId } : {}),
		},
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`Codex quota admission unavailable (HTTP ${response.status})`);
	return response.json();
}

/** Annotate each candidate; selection must rank only after native health filtering. */
export async function admitCodexQuota(
	sources: Pick<RotationSources, "providerId" | "modelId" | "signal" | "getCodexUsage">,
	slots: RotationSlot[],
): Promise<RotationSlot[]> {
	if (sources.providerId !== "openai-codex") return slots;
	const getUsage = sources.getCodexUsage;
	if (!getUsage) throw new Error("Codex quota admission unavailable: missing quota reader");
	const assessed = await Promise.all(
		slots.map(async (slot): Promise<RotationSlot> => {
			if (slot.blockReason === "auth_error" || slot.blockReason === "account_disabled")
				return { ...slot, quotaUnavailable: true };
			let parsed: ReturnType<typeof usageSchema.safeParse>;
			try {
				parsed = usageSchema.safeParse(await getUsage(slot));
			} catch (error) {
				if (sources.signal?.aborted) throw sources.signal.reason;
				if (error instanceof Error && error.name === "AbortError") throw error;
				return { ...slot, blockReason: "account_disabled", quotaUnavailable: true };
			}
			if (!parsed.success) return { ...slot, blockReason: "account_disabled", quotaUnavailable: true };
			const usage = parsed.data;
			const limit = usage.rate_limit;
			const limits = [
				limit,
				...(usage.additional_rate_limits ?? [])
					.filter((entry) => sources.modelId && entry.normal_model_slug === sources.modelId)
					.map((entry) => entry.rate_limit),
			];
			const included = limits.some(
				(entry) =>
					entry.allowed &&
					!entry.limit_reached &&
					[entry.primary_window, entry.secondary_window].every((window) => !window || window.used_percent < 100),
			);
			const exhausted = limits.every(
				(entry) =>
					entry.limit_reached ||
					[entry.primary_window, entry.secondary_window].some((window) => window && window.used_percent >= 100),
			);
			const credits =
				usage.credits?.has_credits === true &&
				usage.credits?.overage_limit_reached !== true &&
				(usage.credits?.unlimited === true || Number(usage.credits?.balance) > 0);
			// A credit-enabled account can still have included quota. Preserve pins
			// and affinity within the included tier; paid-only accounts come last.
			if (included) return { ...slot, quotaTier: 0 };
			if (credits && exhausted) return { ...slot, quotaTier: 1 };
			// This is an admission result, not a permanent credential-store block.
			// The next request rechecks WHAM, so a reset/replenishment is seen immediately.
			return { ...slot, blockReason: "account_disabled", quotaUnavailable: !exhausted };
		}),
	);
	// Unknown is not exhausted: healthy included quota may proceed, but an
	// unavailable quota response must never authorize spending paid credits.
	if (assessed.some((slot) => slot.quotaUnavailable || slot.quotaTier === 0))
		return assessed.map((slot) => (slot.quotaTier === 1 ? { ...slot, blockReason: "account_disabled" } : slot));
	return assessed;
}

export function preferredCodexQuotaTier(candidates: readonly RotationSlot[]): RotationSlot[] {
	const tier = Math.min(...candidates.map((slot) => slot.quotaTier ?? 0));
	return candidates.filter((slot) => (slot.quotaTier ?? 0) === tier);
}
