export type RecoveryCodeMaskSegment = {
	readonly text: string;
	readonly scan: boolean;
};

export type RecoveryCodeMaskFeedOptions = {
	/** A known recovered invoke owns its argument bytes, including backticks. */
	readonly activeInvoke?: boolean;
};

export interface RecoveryCodeMask {
	/** Preserves text byte-for-byte while marking only non-code spans as scannable. */
	feed(text: string, options?: RecoveryCodeMaskFeedOptions): readonly RecoveryCodeMaskSegment[];
	/** Classifies a backtick run retained at the end of the final delta. */
	finish(): readonly RecoveryCodeMaskSegment[];
}

type MaskState =
	| { readonly kind: "plain" }
	| { readonly kind: "inline"; readonly delimiterLength: number }
	| {
			readonly kind: "fenced";
			readonly delimiterLength: number;
			closingLine: boolean;
	  };

function emit(segments: RecoveryCodeMaskSegment[], text: string, scan: boolean): void {
	if (text.length === 0) {
		return;
	}
	const previous = segments.at(-1);
	if (previous?.scan === scan) {
		segments[segments.length - 1] = { text: previous.text + text, scan };
	} else {
		segments.push({ text, scan });
	}
}

/**
 * Incrementally identifies Markdown code spans without parsing Markdown generally.
 * Every input byte is returned exactly once; callers feed only `scan: true` spans
 * into invoke recovery.
 */
export function createRecoveryCodeMask(): RecoveryCodeMask {
	let state: MaskState = { kind: "plain" };
	let atLineStart = true;
	let leadingSpaces = 0;
	let plainIndent = "";
	let pendingTicks = "";
	let pendingAtLineStart = false;

	function flushPlainIndent(segments: RecoveryCodeMaskSegment[], scan: boolean): void {
		emit(segments, plainIndent, scan);
		plainIndent = "";
	}

	function updateLinePosition(character: string): void {
		if (character === "\n") {
			atLineStart = true;
			leadingSpaces = 0;
		} else {
			atLineStart = false;
		}
	}

	function processPlainCharacter(segments: RecoveryCodeMaskSegment[], character: string): void {
		if (atLineStart && character === " " && leadingSpaces < 3) {
			plainIndent += character;
			leadingSpaces += 1;
			return;
		}
		if (character === "`") {
			pendingTicks = character;
			pendingAtLineStart = atLineStart;
			return;
		}
		flushPlainIndent(segments, true);
		emit(segments, character, true);
		updateLinePosition(character);
	}

	function processInlineCharacter(segments: RecoveryCodeMaskSegment[], character: string): void {
		if (character === "`") {
			pendingTicks = character;
			pendingAtLineStart = false;
			return;
		}
		emit(segments, character, false);
		if (character === "\n") {
			state = { kind: "plain" };
			atLineStart = true;
			leadingSpaces = 0;
		} else {
			atLineStart = false;
		}
	}

	function processFencedCharacter(segments: RecoveryCodeMaskSegment[], character: string): void {
		if (state.kind !== "fenced") {
			return;
		}
		if (state.closingLine) {
			emit(segments, character, false);
			if (character === "\n") {
				state = { kind: "plain" };
				atLineStart = true;
				leadingSpaces = 0;
			}
			return;
		}
		if (atLineStart && character === " " && leadingSpaces < 3) {
			emit(segments, character, false);
			leadingSpaces += 1;
			return;
		}
		if (atLineStart && character === "`") {
			pendingTicks = character;
			pendingAtLineStart = true;
			return;
		}
		emit(segments, character, false);
		updateLinePosition(character);
	}

	function completePendingTicks(segments: RecoveryCodeMaskSegment[]): void {
		const ticks = pendingTicks;
		const startedAtLineStart = pendingAtLineStart;
		pendingTicks = "";
		pendingAtLineStart = false;

		if (state.kind === "plain") {
			if (startedAtLineStart && ticks.length >= 3) {
				flushPlainIndent(segments, false);
				emit(segments, ticks, false);
				state = { kind: "fenced", delimiterLength: ticks.length, closingLine: false };
				atLineStart = false;
				leadingSpaces = 0;
				return;
			}
			flushPlainIndent(segments, true);
			emit(segments, ticks, false);
			state = { kind: "inline", delimiterLength: ticks.length };
			atLineStart = false;
			leadingSpaces = 0;
			return;
		}

		if (state.kind === "inline") {
			emit(segments, ticks, false);
			if (ticks.length === state.delimiterLength) {
				state = { kind: "plain" };
			}
			atLineStart = false;
			return;
		}

		emit(segments, ticks, false);
		if (startedAtLineStart && ticks.length === state.delimiterLength) {
			state.closingLine = true;
		}
		atLineStart = false;
		leadingSpaces = 0;
	}

	function processCharacter(segments: RecoveryCodeMaskSegment[], character: string): void {
		if (pendingTicks.length > 0) {
			if (character === "`") {
				pendingTicks += character;
				return;
			}
			completePendingTicks(segments);
		}
		if (state.kind === "plain") {
			processPlainCharacter(segments, character);
		} else if (state.kind === "inline") {
			processInlineCharacter(segments, character);
		} else {
			processFencedCharacter(segments, character);
		}
	}

	return {
		feed(text, options) {
			if (options?.activeInvoke) {
				return text.length === 0 ? [] : [{ text, scan: true }];
			}
			const segments: RecoveryCodeMaskSegment[] = [];
			for (const character of text) {
				processCharacter(segments, character);
			}
			return segments;
		},
		finish() {
			const segments: RecoveryCodeMaskSegment[] = [];
			if (pendingTicks.length > 0) {
				completePendingTicks(segments);
			}
			if (state.kind === "plain") {
				flushPlainIndent(segments, true);
			}
			return segments;
		},
	};
}
