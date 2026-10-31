import { MAX_SLOT_BLOCK_MS } from "@earendil-works/pi-ai/auth/pool/failover";
import { stripProviderRequestIds } from "@earendil-works/pi-ai/utils/retry";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { usageLimitResetMs } from "../credential-pool/reset-time.ts";
import { isTransportFailureText } from "./transient-network.ts";

/**
 * Runtime-only selector suppression. A SelectorCooldowns instance belongs to one
 * AgentSession and is deliberately never persisted to settings or session files.
 * Keys are canonical base selectors (`provider/id`), or a rung (`provider/id:level`) for a
 * hard error that parks only the level that failed (senpi#3311).
 */
export class SelectorCooldowns {
	private readonly expiresAtBySelector = new Map<string, number>();
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly wallNow: () => number;

	constructor(now: () => number, random: () => number = Math.random, wallNow: () => number = now) {
		this.now = now;
		this.random = random;
		this.wallNow = wallNow;
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

	/** Clears `baseSelector` and every rung of it (`baseSelector:<thinking level>`), never another model. */
	clearModel(baseSelector: string): void {
		for (const key of this.expiresAtBySelector.keys()) {
			// Only a rung of this model: a model id may itself contain ':' (openrouter's `x:batch`).
			const rung = key.startsWith(`${baseSelector}:`) && isValidThinkingLevel(key.slice(baseSelector.length + 1));
			if (key === baseSelector || rung) this.expiresAtBySelector.delete(key);
		}
	}

	clearAll(): void {
		this.expiresAtBySelector.clear();
	}

	private durationFor({ retryAfterMs, errorMessage }: { retryAfterMs?: number; errorMessage?: string }): number {
		// Reset hints are wall-clock times; the stored deadline remains monotonic.
		const resetMs = errorMessage === undefined ? undefined : usageLimitResetMs(errorMessage, this.wallNow());
		const message = stripProviderRequestIds(errorMessage ?? "").toLowerCase();
		const defaultMs =
			/usage[- ]limit|quota|insufficient_quota|billing|credits[-_ ]required|credits are required/.test(message)
				? 30 * 60_000
				: /rate[ -]?limit|429|too many requests/.test(message)
					? 30_000
					: /overloaded|capacity/.test(message)
						? 45_000 + this.capacityJitterMs()
						: /5xx|\b5\d\d\b|server|internal error/.test(message)
							? 20_000
							: undefined;
		const retryMs =
			retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : undefined;
		const hintedMs = Math.max(resetMs ?? 0, retryMs ?? 0);
		if (hintedMs > 0) return Math.min(MAX_SLOT_BLOCK_MS, hintedMs);
		if (defaultMs !== undefined) return defaultMs;
		// A reason-less forbidden rejection is a per-request blip on a healthy credential (senpi#2376).
		if (
			/"type"\s*:\s*"forbidden"[^}]*request not allowed|request not allowed[^}]*"type"\s*:\s*"forbidden"/.test(
				message,
			)
		) {
			return 60_000;
		}
		// Transport blips (timeouts, DNS, socket drops) say nothing about model
		// health; the 5-minute default parked the primary and blocked revert-to-primary.
		if (isTransportFailureText(message)) {
			return 60_000;
		}
		return 5 * 60_000;
	}

	private capacityJitterMs(): number {
		return Math.round(Math.min(1, Math.max(0, this.random())) * 30_000);
	}
}
