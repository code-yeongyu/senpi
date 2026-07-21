export type RecoveryCodeMaskSegment = {
	readonly text: string;
	readonly scan: boolean;
	/** Call recovery-parser interrupt before handling this masked span. */
	readonly recoveryBoundary?: true;
};

export type RecoveryCodeMaskFeedOptions = {
	/** A known recovered invoke owns its argument bytes, including backticks. */
	readonly activeInvoke?: boolean;
};

export interface RecoveryCodeMask {
	/** Preserves text byte-for-byte while marking only non-code spans as scannable. */
	feed(text: string, options?: RecoveryCodeMaskFeedOptions): readonly RecoveryCodeMaskSegment[];
	/** Flushes retained state and terminally closes this mask. Further feeds throw. */
	finish(): readonly RecoveryCodeMaskSegment[];
}

type MaskState =
	| { readonly kind: "plain" }
	| { readonly kind: "inline"; readonly delimiterLength: number }
	| { readonly kind: "fenced"; readonly delimiterLength: number; closingLine: boolean };

function emit(segments: RecoveryCodeMaskSegment[], text: string, scan: boolean, recoveryBoundary = false): void {
	if (text.length === 0) {
		return;
	}
	const previous = segments.at(-1);
	if (previous?.scan === scan && !previous.recoveryBoundary && !recoveryBoundary) {
		segments[segments.length - 1] = { text: previous.text + text, scan };
	} else {
		segments.push(recoveryBoundary ? { text, scan, recoveryBoundary: true } : { text, scan });
	}
}

function isLineBreak(character: string): boolean {
	return character === "\r" || character === "\n";
}

/** Incrementally identifies code spans without implementing a general Markdown parser. */
export function createRecoveryCodeMask(): RecoveryCodeMask {
	let state: MaskState = { kind: "plain" };
	let atLineStart = true;
	let leadingSpaces = 0;
	let plainIndent = "";
	let pendingTickCount = 0;
	let pendingDeferredTicks = 0;
	let pendingAtLineStart = false;
	let finished = false;

	function flushPlainIndent(segments: RecoveryCodeMaskSegment[], scan: boolean, recoveryBoundary = false): void {
		emit(segments, plainIndent, scan, recoveryBoundary);
		plainIndent = "";
	}

	function updateLinePosition(character: string): void {
		if (isLineBreak(character)) {
			atLineStart = true;
			leadingSpaces = 0;
		} else {
			atLineStart = false;
		}
	}

	function completePendingTicks(segments: RecoveryCodeMaskSegment[]): void {
		if (pendingTickCount === 0) {
			return;
		}
		const tickCount = pendingTickCount;
		const startedAtLineStart = pendingAtLineStart;
		pendingTickCount = 0;
		pendingAtLineStart = false;

		if (state.kind === "plain") {
			if (startedAtLineStart && tickCount >= 3) {
				flushPlainIndent(segments, false, true);
				state = { kind: "fenced", delimiterLength: tickCount, closingLine: false };
			} else {
				flushPlainIndent(segments, true);
				if (pendingDeferredTicks > 0) {
					emit(segments, "`".repeat(pendingDeferredTicks), false, true);
				}
				state = { kind: "inline", delimiterLength: tickCount };
			}
		} else if (state.kind === "inline") {
			if (tickCount === state.delimiterLength) {
				state = { kind: "plain" };
			}
		} else if (startedAtLineStart && tickCount >= state.delimiterLength) {
			state.closingLine = true;
		}
		pendingDeferredTicks = 0;
		atLineStart = false;
		leadingSpaces = 0;
	}

	function appendTicks(segments: RecoveryCodeMaskSegment[], ticks: string): void {
		if (pendingTickCount === 0) {
			pendingAtLineStart = atLineStart;
		}
		pendingTickCount += ticks.length;
		let offset = 0;
		if (state.kind === "plain" && pendingAtLineStart && plainIndent.length > 0 && pendingDeferredTicks < 3) {
			const deferred = Math.min(3 - pendingDeferredTicks, ticks.length);
			pendingDeferredTicks += deferred;
			offset = deferred;
			if (pendingDeferredTicks === 3) {
				flushPlainIndent(segments, false, true);
				emit(segments, "```", false);
				pendingDeferredTicks = 0;
			}
		}
		if (offset < ticks.length) {
			emit(segments, ticks.slice(offset), false, state.kind === "plain" && pendingTickCount === ticks.length);
		}
	}

	function processPlainCharacter(segments: RecoveryCodeMaskSegment[], character: string): void {
		if (atLineStart && character === " " && leadingSpaces < 3) {
			plainIndent += character;
			leadingSpaces += 1;
			return;
		}
		flushPlainIndent(segments, true);
		emit(segments, character, true);
		updateLinePosition(character);
	}

	function processInlineCharacter(segments: RecoveryCodeMaskSegment[], character: string): void {
		emit(segments, character, false);
		if (isLineBreak(character)) {
			state = { kind: "plain" };
		}
		updateLinePosition(character);
	}

	function processFencedCharacter(segments: RecoveryCodeMaskSegment[], character: string): void {
		if (state.kind !== "fenced") {
			return;
		}
		if (atLineStart && character === " " && leadingSpaces < 3) {
			emit(segments, character, false);
			leadingSpaces += 1;
			return;
		}
		emit(segments, character, false);
		if (state.closingLine && isLineBreak(character)) {
			state = { kind: "plain" };
		}
		updateLinePosition(character);
	}

	function processText(segments: RecoveryCodeMaskSegment[], text: string): void {
		for (let index = 0; index < text.length; ) {
			if (text[index] === "`") {
				let end = index + 1;
				while (text[end] === "`") {
					end += 1;
				}
				appendTicks(segments, text.slice(index, end));
				index = end;
				continue;
			}
			completePendingTicks(segments);
			const character = text.charAt(index);
			if (state.kind === "plain") {
				processPlainCharacter(segments, character);
			} else if (state.kind === "inline") {
				processInlineCharacter(segments, character);
			} else {
				processFencedCharacter(segments, character);
			}
			index += 1;
		}
	}

	function trackActiveText(text: string): void {
		for (let index = 0; index < text.length; index += 1) {
			updateLinePosition(text.charAt(index));
		}
	}

	return {
		feed(text, options) {
			if (finished) {
				throw new Error("Recovery code mask is finished");
			}
			const segments: RecoveryCodeMaskSegment[] = [];
			if (options?.activeInvoke) {
				completePendingTicks(segments);
				flushPlainIndent(segments, true);
				emit(segments, text, true);
				trackActiveText(text);
			} else {
				processText(segments, text);
			}
			return segments;
		},
		finish() {
			if (finished) {
				return [];
			}
			const segments: RecoveryCodeMaskSegment[] = [];
			completePendingTicks(segments);
			if (state.kind === "plain") {
				flushPlainIndent(segments, true);
			}
			finished = true;
			return segments;
		},
	};
}
