import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableErrorMessage } from "@earendil-works/pi-ai";
import { type Component, type Container, Text } from "@earendil-works/pi-tui";
import { z } from "zod";
import { keyText } from "./components/keybinding-hints.ts";
import { sanitizeTuiErrorMessage } from "./extension-error-format.ts";
import { theme } from "./theme/theme.ts";

const envelope = z.object({
	type: z.literal("error").optional(),
	error: z.object({ type: z.string(), message: z.string() }),
});
const networkFailure =
	/network error|service unavailable|connection (?:error|lost|reset)|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|overloaded/i;
const otherFailure = /auth|api.?key|permission|quota|credit|billing|rate.?limit|too many requests|429/i;

/** Presentation classification only. Retry eligibility remains owned by AgentSession. */
export function isNetworkProviderError(raw: string | undefined, envelopeOnly = false): boolean {
	if (!raw || otherFailure.test(raw)) return false;
	if (!envelopeOnly) return networkFailure.test(raw);
	try {
		const parsed = envelope.safeParse(JSON.parse(raw));
		return parsed.success && networkFailure.test(parsed.data.error.message);
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
}

/**
 * True when a provider failure should take the quiet presentation path (one banner, a
 * status-line countdown while retrying, raw JSON only on expand): any transient failure,
 * which is a network drop, a 429 rate-limit, or a 5xx. Hard quota/auth/billing failures
 * classify non-retryable here and stay verbose, because they need a credential or plan
 * change, not a wait. Delegates to the shared classifier so the transcript decision and
 * the retry engine never disagree about what is transient.
 */
export function isRetryableProviderError(raw: string | undefined): boolean {
	if (!raw) return false;
	if (isNetworkProviderError(raw)) return true;
	return isRetryableErrorMessage(raw);
}

export function isNetworkProviderMessage(message: AssistantMessage): boolean {
	return (
		(message.stopReason === "error" || message.stopReason === "aborted") &&
		isNetworkProviderError(message.errorMessage)
	);
}

class ProviderFailureNotice implements Component {
	private readonly details = new Set<string>();
	private expanded = false;
	private summary: string | undefined = "The model provider may be having trouble.";

	add(raw: string): void {
		this.details.add(raw);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	setSummary(summary: string | undefined): void {
		this.summary = summary;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.summary) {
			lines.push(
				...new Text(
					theme.fg("warning", `${this.summary} (${keyText("app.tools.expand")} for details)`),
					1,
					0,
				).render(width),
			);
		}
		if (this.expanded) {
			for (const raw of this.details) {
				lines.push(...new Text(theme.fg("dim", sanitizeTuiErrorMessage(raw)), 1, 0).render(width));
			}
		}
		return lines;
	}

	invalidate(): void {}
}

/** Owns one display episode, not session messages or retry/fallback policy. */
export class ProviderErrorPresentation {
	private readonly chat: Container;
	private notice: ProviderFailureNotice | undefined;
	private pending = false;

	constructor(chat: Container) {
		this.chat = chat;
	}

	record(raw: string, expanded = false): void {
		this.pending = true;
		this.retryAwaitingFinish = true;
		if (!this.notice) {
			this.notice = new ProviderFailureNotice();
			this.notice.setExpanded(expanded);
			this.chat.addChild(this.notice);
		}
		this.notice.add(raw);
	}

	retrying(raw: string, expanded: boolean): void {
		this.record(raw, expanded);
		// RetryStatusIndicator owns the single visible transient row.
		this.notice?.setSummary(undefined);
	}

	/** A success or cleanup ends the episode: no finish is owed afterward. */
	clear(): void {
		this.pending = false;
		this.retryAwaitingFinish = false;
		// Keep diagnostics reachable through the existing expansion affordance.
		this.notice?.setSummary(undefined);
	}

	/**
	 * The retry engine finishing (summarization_retry_finished): clears the transient row but keeps
	 * the episode marker, because the terminal compaction_end that follows still closes the
	 * exhausted episode out via finish().
	 */
	clearTransient(): void {
		this.pending = false;
		this.notice?.setSummary(undefined);
	}

	/** True while a retry episode is active (a retry was recorded and not yet finished/cleared). */
	get hasActiveRetry(): boolean {
		return this.pending;
	}

	/**
	 * True only while a retry has been recorded in the CURRENT episode and not yet closed out by
	 * finish(). A fresh terminal failure after an episode that already finished returns false, so
	 * it surfaces as a plain error instead of reopening the stale banner.
	 */
	get awaitingRetryFinish(): boolean {
		return this.retryAwaitingFinish;
	}

	private retryAwaitingFinish = false;

	finish(raw?: string, attempts?: number): void {
		if (raw) this.record(raw);
		if (!this.pending) return;
		this.pending = false;
		this.retryAwaitingFinish = false;
		const count = attempts === undefined ? "" : ` after ${attempts} retries`;
		this.notice?.setSummary(
			`The model provider could not complete the request${count}. Try again or choose another model with /model.`,
		);
	}

	newTurn(): void {
		this.finish();
		this.notice = undefined;
	}
}
