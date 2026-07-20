/**
 * Runtime-only selector suppression. A SelectorCooldowns instance belongs to one
 * AgentSession and is deliberately never persisted to settings or session files.
 * Callers provide canonical base selectors without a thinking suffix.
 */
export class SelectorCooldowns {
	private readonly expiresAtBySelector = new Map<string, number>();
	private readonly now: () => number;
	private readonly random: () => number;

	constructor(now: () => number, random: () => number = Math.random) {
		this.now = now;
		this.random = random;
	}

	note(baseSelector: string, failure: { retryAfterMs?: number; errorMessage?: string }): void {
		this.expiresAtBySelector.set(baseSelector, this.now() + this.durationFor(failure));
	}

	isSuppressed(baseSelector: string): boolean {
		const expiresAt = this.expiresAtBySelector.get(baseSelector);
		if (expiresAt === undefined) return false;
		if (this.now() < expiresAt) return true;
		this.expiresAtBySelector.delete(baseSelector);
		return false;
	}

	clear(baseSelector: string): void {
		this.expiresAtBySelector.delete(baseSelector);
	}

	clearAll(): void {
		this.expiresAtBySelector.clear();
	}

	private durationFor({ retryAfterMs, errorMessage }: { retryAfterMs?: number; errorMessage?: string }): number {
		if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
			return retryAfterMs;
		}

		const message = errorMessage?.toLowerCase() ?? "";
		if (/usage[- ]limit|quota|insufficient_quota|billing/.test(message)) return 30 * 60_000;
		if (/rate[ -]?limit|429|too many requests/.test(message)) return 30_000;
		if (/overloaded|capacity/.test(message)) return 45_000 + this.capacityJitterMs();
		if (/5xx|\b5\d\d\b|server|internal error/.test(message)) return 20_000;
		return 5 * 60_000;
	}

	private capacityJitterMs(): number {
		return Math.round(Math.min(1, Math.max(0, this.random())) * 30_000);
	}
}
