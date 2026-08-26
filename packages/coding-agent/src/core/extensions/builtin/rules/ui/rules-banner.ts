import { Container } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../../modes/interactive/theme/theme.ts";
import { buildNoticeBox, type NoticeLine } from "../../../notice/index.ts";
import type { LoadedRule, RuleDiagnostic } from "../rules/types.ts";

export interface RulesBannerProps {
	ruleCount: number;
	diagnostics: ReadonlyArray<RuleDiagnostic>;
	topRules?: ReadonlyArray<Pick<LoadedRule, "relativePath" | "matchReason">>;
}

export class RulesBanner extends Container {
	private readonly props: RulesBannerProps;
	private readonly theme: Theme;

	constructor(props: RulesBannerProps, theme: Theme) {
		super();
		this.props = props;
		this.theme = theme;
	}

	override render(width: number): string[] {
		return renderBannerLines(this.props, this.theme, width);
	}

	override invalidate(): void {}
}

export function renderBannerLines(props: RulesBannerProps, theme: Theme, width: number): string[] {
	if (props.ruleCount === 0) {
		return buildNoticeBox(
			{
				title: "[pi-rules] No rules discovered",
				tone: "accent",
				why: "No rules were discovered.",
			},
			{ expanded: false },
			theme,
		).render(width);
	}

	const extra: NoticeLine[] = (props.topRules ?? []).map((rule) => {
		const hasDiagnostic = props.diagnostics.some((diagnostic) => diagnostic.source === rule.relativePath);
		const annotation =
			typeof rule.matchReason === "object" && rule.matchReason.kind === "glob" ? ` ${rule.matchReason.pattern}` : "";
		return {
			text: `  ${hasDiagnostic ? "⚠" : "●"} ${rule.relativePath}${annotation}`,
			tone: hasDiagnostic ? ("error" as const) : ("success" as const),
		};
	});
	if (props.diagnostics.length > 0) {
		extra.push({ text: `  ⚠ ${props.diagnostics.length} warning(s)`, tone: "warning" });
	}

	return buildNoticeBox(
		{
			title: `[pi-rules] ${props.ruleCount} active rules`,
			tone: "accent",
			why: `${props.ruleCount} active rules were discovered.`,
			extra,
		},
		{ expanded: false },
		theme,
	).render(width);
}

export interface StatusLineInput {
	ruleCount: number;
	hasErrors: boolean;
}

export function statusLineText(input: StatusLineInput, theme: Theme): string {
	const base = `[pi-rules] ${input.ruleCount} active`;
	if (input.hasErrors) {
		return theme.fg("muted", `${base} · `) + theme.fg("error", "⚠ errors");
	}
	return theme.fg("muted", base);
}
