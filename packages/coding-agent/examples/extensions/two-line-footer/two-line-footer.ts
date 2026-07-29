import type { ExtensionContext } from "@code-yeongyu/senpi";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	alignStyledFooterLine,
	buildFooterUsageSegments,
	compactWorkingDirectory,
	type FooterText,
	type FooterUsageTotals,
	formatTokens,
	planFooterBottomLine,
	sanitizeFooterLabel,
	sortedFooterStatuses,
} from "./footer-layout.ts";

type FooterFactory = Exclude<Parameters<ExtensionContext["ui"]["setFooter"]>[0], undefined>;

function collectUsageTotals(sessionManager: ExtensionContext["sessionManager"]): FooterUsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;

	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (!usage) continue;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		cost += usage.cost?.total ?? 0;
		const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		latestCacheHitRate = latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
		latestCacheHitRate,
	};
}

export function createTwoLineFooterFactory(ctx: ExtensionContext): FooterFactory {
	return (tui, theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const separator = theme.fg("borderMuted", " | ");
				const footerTextTools = {
					colorTruncatedLeft: (text: string) => theme.fg("muted", text),
					measure: visibleWidth,
					truncate: truncateToWidth,
				};
				const alignLine = (left: FooterText, right: FooterText): string =>
					alignStyledFooterLine({ left, right, width }, footerTextTools);

				const usage = collectUsageTotals(ctx.sessionManager);
				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const contextPercentValue = contextUsage?.percent ?? 0;
				const contextPercent = typeof contextUsage?.percent === "number" ? contextUsage.percent.toFixed(1) : "?";
				const contextTokens =
					typeof contextUsage?.tokens === "number"
						? formatTokens(contextUsage.tokens)
						: typeof contextUsage?.percent === "number"
							? formatTokens(Math.round((contextWindow * contextUsage.percent) / 100))
							: "?";
				const autoIndicator = ctx.getCompactionSettings().enabled ? " (auto)" : "";
				const contextText =
					contextPercent === "?"
						? `${contextTokens}/${formatTokens(contextWindow)} (?)${autoIndicator}`
						: `${contextTokens}/${formatTokens(contextWindow)} (${contextPercent}%)${autoIndicator}`;
				const contextColored =
					contextPercentValue > 90
						? theme.fg("error", contextText)
						: contextPercentValue > 70
							? theme.fg("warning", contextText)
							: theme.fg("muted", contextText);

				const path = compactWorkingDirectory(ctx.cwd);
				const branch = sanitizeFooterLabel(footerData.getGitBranch() ?? "");
				const sessionName = sanitizeFooterLabel(ctx.sessionManager.getSessionName() ?? "");
				const topPlainSegments = [path];
				const topColoredSegments = [theme.fg("accent", path)];
				if (branch) {
					topPlainSegments.push(branch);
					topColoredSegments.push(theme.fg("warning", branch));
				}
				if (sessionName) {
					topPlainSegments.push(sessionName);
					topColoredSegments.push(theme.fg("muted", sessionName));
				}
				const topLeftPlain = topPlainSegments.join(" | ");
				const topLeftColored = topColoredSegments.join(separator);

				const modelName = sanitizeFooterLabel(ctx.model?.id ?? "no-model");
				const thinkingSuffix = ctx.model?.reasoning ? `:${ctx.thinkingLevel ?? "off"}` : "";
				const modelWithoutProvider = `${modelName}${thinkingSuffix}`;
				const providerPrefix =
					footerData.getAvailableProviderCount() > 1 && ctx.model
						? `(${sanitizeFooterLabel(ctx.model.provider)}) `
						: "";
				const modelWithProvider = `${providerPrefix}${modelWithoutProvider}`;
				const modelPlain =
					visibleWidth(topLeftPlain) + 2 + visibleWidth(modelWithProvider) <= width
						? modelWithProvider
						: modelWithoutProvider;
				const coloredModel = `${theme.fg("accent", modelName)}${theme.fg("dim", thinkingSuffix)}`;
				const modelColored =
					modelPlain === modelWithProvider && providerPrefix
						? `${theme.fg("muted", providerPrefix)}${coloredModel}`
						: coloredModel;

				const usingSubscription = ctx.model
					? ctx.model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(ctx.model)
					: false;
				const usageSegments = buildFooterUsageSegments(usage, usingSubscription);
				const bottomPlainSegments = usageSegments.map(({ text }) => text);
				const bottomColoredSegments = usageSegments.map(({ color, text }) => theme.fg(color, text));
				const statuses = sortedFooterStatuses(footerData.getExtensionStatuses());
				const bottomLine = planFooterBottomLine(bottomPlainSegments, contextText, statuses, width, visibleWidth);
				const statusColored = statuses.map((status) => theme.fg("dim", status)).join(separator);
				const bottomRightColored =
					statuses.length === 0
						? contextColored
						: bottomLine.right === statuses.join(" | ")
							? statusColored
							: bottomLine.right === `${contextText} | ${statuses.join(" | ")}`
								? [contextColored, statusColored].join(separator)
								: `${theme.fg("dim", "...")}${separator}${statusColored}`;

				return [
					alignLine(
						{ colored: topLeftColored, plain: topLeftPlain },
						{ colored: modelColored, plain: modelPlain },
					),
					alignLine(
						{
							colored: bottomColoredSegments.join(separator),
							plain: bottomLine.left,
						},
						{ colored: bottomRightColored, plain: bottomLine.right },
					),
				];
			},
		};
	};
}
