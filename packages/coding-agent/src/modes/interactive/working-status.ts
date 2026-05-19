const WORKING_STATUS_MESSAGE_SHIMMER_PADDING = 10;
const WORKING_STATUS_MESSAGE_SHIMMER_BAND_HALF_WIDTH = 5;
const WORKING_STATUS_MESSAGE_SHIMMER_SWEEP_MS = 2_000;

export type WorkingStatusRgbColor = {
	r: number;
	g: number;
	b: number;
};

type WorkingStatusTextFrameStyle = {
	base: (text: string) => string;
	glow: (text: string) => string;
	highlight: (text: string) => string;
	shimmer?: (text: string, intensity: number) => string;
};

type WorkingStatusMessageFrameStyle = WorkingStatusTextFrameStyle & {
	suffix: (text: string) => string;
};

export function formatWorkingElapsedSeconds(elapsedSeconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedSeconds));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	if (totalSeconds < 3600) {
		return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatWorkingStatusMessage(message: string, elapsedSeconds: number, interruptKey: string): string {
	return `${message} (${formatWorkingElapsedSeconds(elapsedSeconds)} • ${interruptKey} to interrupt)`;
}

export type ToolHookStatusHookName = "PreToolUse" | "PostToolUse";

export function formatToolHookStatusMessage(
	hookName: ToolHookStatusHookName,
	statusMessage: string,
	elapsedSeconds: number,
): string {
	const suffix = statusMessage ? `: ${statusMessage}` : "";
	return `Running ${hookName} hook${suffix} (${formatWorkingElapsedSeconds(elapsedSeconds)})`;
}

function clampColorChannel(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

export function blendWorkingStatusShimmerRgbColor(
	highlight: WorkingStatusRgbColor,
	base: WorkingStatusRgbColor,
	amount: number,
): WorkingStatusRgbColor {
	const clampedAmount = Math.max(0, Math.min(1, amount));
	return {
		r: clampColorChannel(highlight.r * clampedAmount + base.r * (1 - clampedAmount)),
		g: clampColorChannel(highlight.g * clampedAmount + base.g * (1 - clampedAmount)),
		b: clampColorChannel(highlight.b * clampedAmount + base.b * (1 - clampedAmount)),
	};
}

export function formatWorkingStatusTextFrame(
	statusMessage: string,
	animationElapsedMs: number,
	style: WorkingStatusTextFrameStyle,
): string {
	const chars = Array.from(statusMessage);
	if (chars.length === 0) {
		return "";
	}

	const period = chars.length + WORKING_STATUS_MESSAGE_SHIMMER_PADDING * 2;
	const sweepProgress =
		((Math.max(0, animationElapsedMs) % WORKING_STATUS_MESSAGE_SHIMMER_SWEEP_MS) /
			WORKING_STATUS_MESSAGE_SHIMMER_SWEEP_MS) *
		period;

	return chars
		.map((char, index) => {
			if (char === " ") {
				return char;
			}
			const distance = Math.abs(index + WORKING_STATUS_MESSAGE_SHIMMER_PADDING - sweepProgress);
			if (distance > WORKING_STATUS_MESSAGE_SHIMMER_BAND_HALF_WIDTH) {
				if (style.shimmer) {
					return style.shimmer(char, 0);
				}
				return style.base(char);
			}

			const intensity = 0.5 * (1 + Math.cos(Math.PI * (distance / WORKING_STATUS_MESSAGE_SHIMMER_BAND_HALF_WIDTH)));
			if (style.shimmer) {
				return style.shimmer(char, intensity);
			}
			if (intensity < 0.2) {
				return style.base(char);
			}
			if (intensity < 0.6) {
				return style.glow(char);
			}
			return style.highlight(char);
		})
		.join("");
}

export function formatWorkingStatusMessageFrame(
	message: string,
	elapsedSeconds: number,
	interruptKey: string,
	animationElapsedMs: number,
	style: WorkingStatusMessageFrameStyle,
): string {
	const suffix = ` (${formatWorkingElapsedSeconds(elapsedSeconds)} • ${interruptKey} to interrupt)`;
	return `${formatWorkingStatusTextFrame(message, animationElapsedMs, style)}${style.suffix(suffix)}`;
}

export function formatToolHookStatusMessageFrame(
	hookName: ToolHookStatusHookName,
	statusMessage: string,
	elapsedSeconds: number,
	animationElapsedMs: number,
	style: WorkingStatusMessageFrameStyle,
): string {
	const label = `Running ${hookName} hook`;
	const statusSuffix = statusMessage ? `: ${statusMessage}` : "";
	const suffix = `${statusSuffix} (${formatWorkingElapsedSeconds(elapsedSeconds)})`;
	return `${formatWorkingStatusTextFrame(label, animationElapsedMs, style)}${style.suffix(suffix)}`;
}
