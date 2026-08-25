export interface RetryStageOverride {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	growthFactor?: number;
	perAttemptCapMs?: number | null;
	jitter?: { mode: "none" } | { mode: "additive" | "subtractive"; ratio: number };
	serverHintMaxDelayMs?: number | null;
}

export interface RetryPolicyOverride {
	providerRequest?: RetryStageOverride;
	turn?: RetryStageOverride;
}

export interface ValidatedRetryProviderOverrides {
	overrides: Record<string, RetryPolicyOverride>;
	warnings: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return `a ${typeof value}`;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteAtLeast(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= min;
}

function isFiniteRatio(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateStageKnobs(
	stage: unknown,
	providerId: string,
	stageName: string,
	warnings: string[],
): RetryStageOverride | undefined {
	if (stage === undefined) return undefined;
	if (!isPlainObject(stage)) {
		warnings.push(
			`retry.providers.${providerId}.${stageName} must be a plain object, but got ${describeValue(stage)}.`,
		);
		return undefined;
	}

	const out: RetryStageOverride = {};
	const invalid: string[] = [];

	if (stage.enabled !== undefined) {
		if (typeof stage.enabled === "boolean") out.enabled = stage.enabled;
		else invalid.push("enabled");
	}
	if (stage.maxRetries !== undefined) {
		if (isNonNegativeSafeInteger(stage.maxRetries)) out.maxRetries = stage.maxRetries;
		else invalid.push("maxRetries");
	}
	if (stage.baseDelayMs !== undefined) {
		if (isNonNegativeSafeInteger(stage.baseDelayMs)) out.baseDelayMs = stage.baseDelayMs;
		else invalid.push("baseDelayMs");
	}
	if (stage.growthFactor !== undefined) {
		if (isFiniteAtLeast(stage.growthFactor, 1)) out.growthFactor = stage.growthFactor;
		else invalid.push("growthFactor");
	}
	if (stage.perAttemptCapMs !== undefined) {
		if (stage.perAttemptCapMs === null) out.perAttemptCapMs = null;
		else if (isNonNegativeSafeInteger(stage.perAttemptCapMs)) out.perAttemptCapMs = stage.perAttemptCapMs;
		else invalid.push("perAttemptCapMs");
	}
	if (stage.jitter !== undefined) {
		if (isPlainObject(stage.jitter)) {
			const mode = stage.jitter.mode;
			if (mode === "none") out.jitter = { mode: "none" };
			else if ((mode === "additive" || mode === "subtractive") && isFiniteRatio(stage.jitter.ratio)) {
				out.jitter = { mode, ratio: stage.jitter.ratio };
			} else invalid.push("jitter");
		} else invalid.push("jitter");
	}
	if (stage.serverHintMaxDelayMs !== undefined) {
		if (stage.serverHintMaxDelayMs === null) out.serverHintMaxDelayMs = null;
		else if (isNonNegativeSafeInteger(stage.serverHintMaxDelayMs))
			out.serverHintMaxDelayMs = stage.serverHintMaxDelayMs;
		else invalid.push("serverHintMaxDelayMs");
	}

	if (invalid.length > 0) {
		warnings.push(`retry.providers.${providerId}.${stageName} has invalid knob(s): ${invalid.join(", ")}.`);
		return undefined;
	}
	return out;
}

export function validateRetryProviderOverrides(
	value: unknown,
	knownProviderIds: ReadonlySet<string>,
	tieredProviderIds?: ReadonlySet<string>,
): ValidatedRetryProviderOverrides {
	if (value === undefined) return { overrides: {}, warnings: [] };
	if (!isPlainObject(value)) {
		return {
			overrides: {},
			warnings: [`retry.providers must be a plain object keyed by provider id, but got ${describeValue(value)}.`],
		};
	}

	const overrides: Record<string, RetryPolicyOverride> = {};
	const warnings: string[] = [];

	for (const [providerId, entry] of Object.entries(value)) {
		if (!knownProviderIds.has(providerId)) {
			warnings.push(`retry.providers.${providerId}: unknown provider id "${providerId}".`);
			continue;
		}
		if (!isPlainObject(entry)) {
			warnings.push(`retry.providers.${providerId} must be a plain object, but got ${describeValue(entry)}.`);
			continue;
		}

		const stageWarnings: string[] = [];
		const providerRequest = validateStageKnobs(entry.providerRequest, providerId, "providerRequest", stageWarnings);
		const turn = validateStageKnobs(entry.turn, providerId, "turn", stageWarnings);

		if (stageWarnings.length > 0) {
			warnings.push(...stageWarnings);
			continue;
		}

		if (tieredProviderIds?.has(providerId)) {
			if (providerRequest?.serverHintMaxDelayMs !== undefined || turn?.serverHintMaxDelayMs !== undefined) {
				warnings.push(
					`retry.providers.${providerId}: serverHintMaxDelayMs is invalid for a tiered stage (tier thresholds own that strategy).`,
				);
				continue;
			}
		}

		const result: RetryPolicyOverride = {};
		if (providerRequest !== undefined) result.providerRequest = providerRequest;
		if (turn !== undefined) result.turn = turn;
		if (providerRequest === undefined && turn === undefined) {
			warnings.push(`retry.providers.${providerId} has no recognized knobs.`);
			continue;
		}
		overrides[providerId] = result;
	}

	return { overrides, warnings };
}
