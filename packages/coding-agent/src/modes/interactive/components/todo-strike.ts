export const TODO_STRIKE_HOLD_FRAMES = 2;
export const TODO_STRIKE_REVEAL_FRAMES = 12;
export const TODO_STRIKE_TOTAL_FRAMES = TODO_STRIKE_HOLD_FRAMES + TODO_STRIKE_REVEAL_FRAMES;
export const TODO_STRIKE_FRAME_INTERVAL_MS = 65;

export function strikeRevealCount(text: string, frame: number | undefined): number | undefined {
	if (frame === undefined) {
		return undefined;
	}
	if (frame <= TODO_STRIKE_HOLD_FRAMES) {
		return 0;
	}

	const chars = [...text];
	if (chars.length === 0) {
		return undefined;
	}

	return Math.ceil(
		(chars.length * Math.min(frame - TODO_STRIKE_HOLD_FRAMES, TODO_STRIKE_REVEAL_FRAMES)) / TODO_STRIKE_REVEAL_FRAMES,
	);
}

export function partialStrikethrough(text: string, visibleChars: number, strike: (text: string) => string): string {
	if (visibleChars <= 0) {
		return text;
	}

	const chars = [...text];
	if (visibleChars >= chars.length) {
		return strike(text);
	}

	return strike(chars.slice(0, visibleChars).join("")) + chars.slice(visibleChars).join("");
}

export function hasCompletedTodoTasks(details: unknown): boolean {
	if (details === null || typeof details !== "object") {
		return false;
	}

	const completedTasks = (details as { completedTasks?: unknown }).completedTasks;
	return Array.isArray(completedTasks) && completedTasks.length > 0;
}
