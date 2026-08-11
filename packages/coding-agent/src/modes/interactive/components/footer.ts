import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";
import { type FooterSegment, planFooterLayout } from "./footer-layout.ts";

const FAST_MODE_INDICATOR = "\u26a1 ";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for footer display using oh-my-pi-style K/M/B abbreviation.
 * Examples: "999", "6.8K", "546K", "1M", "1.5M", "2B".
 */
export function formatTokens(count: number): string {
	const n = Math.round(count);
	if (n < 1_000) return n.toString();
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

/** Format with up to 1 decimal place, dropping trailing `.0`. */
function trim1(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Color the right side of the footer: (provider) muted, model accent, :thinking dim.
 * The text is the plain (uncolored) right-aligned segment from the layout pass.
 */
function colorRightSide(text: string): string {
	if (!text) return "";
	const providerMatch = text.match(/^\(([^)]+)\) (.*)$/);
	const afterProvider = providerMatch ? providerMatch[2] : text;
	const providerPrefix = providerMatch ? theme.fg("muted", `(${providerMatch[1]}) `) : "";
	const fastPrefix = afterProvider.startsWith(FAST_MODE_INDICATOR) ? theme.fg("warning", FAST_MODE_INDICATOR) : "";
	const body = fastPrefix ? afterProvider.slice(FAST_MODE_INDICATOR.length) : afterProvider;
	const thinkingMatch = body.match(/^(.+):([^:]+)$/);
	if (!thinkingMatch) return providerPrefix + fastPrefix + theme.fg("accent", body);
	return `${providerPrefix}${fastPrefix}${theme.fg("accent", thinkingMatch[1])}${theme.fg("dim", `:${thinkingMatch[2]}`)}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private autoCompactEnabled = true;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(width: number): string[] {
		const state = this.session.state;

		// O(1) running totals maintained by SessionManager (identical to summing
		// usage over all entries; totals are not branch-scoped).
		const usageTotals = this.session.sessionManager.getUsageTotals();
		const totalCacheRead = usageTotals.cacheRead;
		const totalCacheWrite = usageTotals.cacheWrite;
		const totalCost = usageTotals.cost;
		const latestCacheHitRate = usageTotals.latestCacheHitRate;

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const contextTokens =
			typeof contextUsage?.tokens === "number"
				? formatTokens(contextUsage.tokens)
				: typeof contextUsage?.percent === "number"
					? formatTokens(Math.round((contextWindow * contextUsage.percent) / 100))
					: "?";

		// Segments in priority order: anchors (pwd, branch, context) and the model
		// label always stay; middle stats elide from the right when space runs out.
		// The width ladder itself lives in ./footer-layout.ts.
		const separator = " • ";
		const sepColored = theme.fg("borderMuted", separator);
		const pwdRaw = formatCwdForFooter(
			this.session.sessionManager.getCwd(),
			process.env.HOME || process.env.USERPROFILE,
		);
		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();

		const anchor: [FooterSegment, ...FooterSegment[]] = [{ plain: pwdRaw, colored: theme.fg("accent", pwdRaw) }];
		if (branch) anchor.push({ plain: branch, colored: theme.fg("warning", branch) });
		const pwdIndex = 0;

		const dim = (plain: string): FooterSegment => ({ plain, colored: theme.fg("dim", plain) });
		const middle: FooterSegment[] = [];
		if (sessionName) middle.push({ plain: sessionName, colored: theme.fg("muted", sessionName) });
		if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined && latestCacheHitRate >= 10) {
			middle.push(dim(`CH${latestCacheHitRate.toFixed(1)}%`));
		}

		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingOAuth(state.model.provider)
			: false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			middle.push({ plain: costStr, colored: theme.fg("success", costStr) });
		}

		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const ctxDisplay =
			contextPercent === "?"
				? `${contextTokens}/${formatTokens(contextWindow)} (?)${autoIndicator}`
				: `${contextTokens}/${formatTokens(contextWindow)} (${contextPercent}%)${autoIndicator}`;
		const ctxColored =
			contextPercentValue > 90
				? theme.fg("error", ctxDisplay)
				: contextPercentValue > 70
					? theme.fg("warning", ctxDisplay)
					: theme.fg("muted", ctxDisplay);
		const tail: FooterSegment = { plain: ctxDisplay, colored: ctxColored };

		// Model label pinned to the right edge; the provider prefix stays only when
		// the full line fits.
		const modelName = state.model?.id || "no-model";
		const fastIndicator = this.session.isFastModeActive() ? FAST_MODE_INDICATOR : "";
		let minimalRight = `${fastIndicator}${modelName}`;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			minimalRight = thinkingLevel === "off" ? `${minimalRight}:off` : `${minimalRight}:${thinkingLevel}`;
		}
		const minimal: FooterSegment = { plain: minimalRight, colored: colorRightSide(minimalRight) };
		const providerPrefix =
			this.footerData.getAvailableProviderCount() > 1 && state.model ? `(${state.model.provider}) ` : "";
		const full: FooterSegment | undefined = providerPrefix
			? { plain: `${providerPrefix}${minimalRight}`, colored: colorRightSide(`${providerPrefix}${minimalRight}`) }
			: undefined;

		const marker: FooterSegment = { plain: "…", colored: theme.fg("dim", "…") };
		const plan = planFooterLayout({
			width,
			anchor,
			pwdIndex,
			middle,
			tail,
			right: { minimal, full },
			separator,
			minPadding: 2,
			ellipsisMarker: marker,
		});

		const joinSegments = (segments: readonly FooterSegment[]): { colored: string; width: number } => ({
			colored: segments.map((segment) => segment.colored).join(sepColored),
			width: visibleWidth(segments.map((segment) => segment.plain).join(separator)),
		});

		let left: { colored: string; width: number };
		let right: FooterSegment;
		if (plan.kind === "full") {
			right = plan.useFullRight && full ? full : minimal;
			left = joinSegments([...anchor, ...middle, tail]);
		} else if (plan.kind === "middle-elided") {
			right = plan.useFullRight && full ? full : minimal;
			const segments = [...anchor, ...middle.slice(0, plan.keptMiddleCount)];
			if (plan.showMarker) segments.push(marker);
			segments.push(tail);
			left = joinSegments(segments);
		} else if (plan.kind === "pwd-elided") {
			right = plan.useFullRight && full ? full : minimal;
			const segments: FooterSegment[] = [
				...anchor.map((segment, index) =>
					index === pwdIndex ? { plain: plan.pwdPlain, colored: theme.fg("accent", plan.pwdPlain) } : segment,
				),
				...middle.slice(0, plan.keptMiddleCount),
			];
			if (plan.showMarker) segments.push(marker);
			segments.push(tail);
			left = joinSegments(segments);
		} else if (plan.kind === "left-elided") {
			right = minimal;
			left = { colored: theme.fg("muted", plan.leftPlain), width: visibleWidth(plan.leftPlain) };
		} else {
			left = { colored: "", width: 0 };
			right = { plain: plan.rightPlain, colored: colorRightSide(plan.rightPlain) };
		}

		const rightWidth = visibleWidth(right.plain);
		const padding = " ".repeat(Math.max(0, width - left.width - rightWidth));
		const lines = [left.colored + padding + right.colored];

		// Add extension statuses on a single line, sorted by key alphabetically
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
