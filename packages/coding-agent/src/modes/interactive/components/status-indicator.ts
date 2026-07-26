import {
	type Component,
	Loader,
	type LoaderIndicatorOptions,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: LoaderIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}

	setProgressText(_progressText: string): void {
		// Only compaction status renders progress.
	}
}

export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string, indicator?: LoaderIndicatorOptions) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
	}
}

export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

export type CompactionStatusReason = "manual" | "threshold" | "overflow" | "pre_prompt" | "branch" | "extension";

export class CompactionStatusIndicator extends StatusIndicator {
	private progressText = "";
	private readonly progressLabel: string;

	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: reason === "overflow"
					? `Context overflow detected, compacting... ${cancelHint}`
					: reason === "pre_prompt"
						? `Compacting before next prompt... ${cancelHint}`
						: reason === "threshold"
							? `Auto-compacting... ${cancelHint}`
							: `Compacting context... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		// Once a streamed preview needs room, the reason-specific label collapses to the
		// shortest form that still keeps the cancellation hint fully visible.
		this.progressLabel = `Compacting... ${cancelHint}`;
	}

	setProgressText(progressText: string): void {
		if (!this.progressText && progressText) this.setMessage(this.progressLabel);
		this.progressText = progressText;
	}

	override render(width: number): string[] {
		// Loader.render() prepends a spacer row; joining keeps this indicator a single row
		// whether or not a preview is present, so the composer never shifts between states.
		// Text pads rows to the full width, so trailing padding is stripped before measuring.
		let status = super.render(width).join(" ").trimEnd();
		// On narrow terminals the reason-specific label can wrap even before any preview
		// arrives, and head-truncating the joined rows would drop the cancellation hint.
		// Collapse to the compact label whenever the full status cannot fit on one row.
		if (visibleWidth(status) > width) {
			this.setMessage(this.progressLabel);
			status = super.render(width).join(" ").trimEnd();
		}
		if (!this.progressText) return [truncateToWidth(status, width)];
		// The status label (with its cancellation hint) is allocated first; the preview only
		// receives whatever width is left over instead of starving the hint out of the row.
		const progressWidth = Math.min(visibleWidth(this.progressText), width - visibleWidth(status) - 1);
		if (progressWidth <= 0) return [truncateToWidth(status, width)];
		// The preview is accumulated summary text, so keep the newest trailing columns.
		const totalProgressWidth = visibleWidth(this.progressText);
		const progressTail =
			totalProgressWidth > progressWidth
				? sliceByColumn(this.progressText, totalProgressWidth - progressWidth, progressWidth)
				: this.progressText;
		return [truncateToWidth(`${status} ${theme.fg("muted", progressTail)}`, width)];
	}
}

export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

export class IdleStatus implements Component {
	invalidate(): void {
		// No cached state to invalidate.
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
