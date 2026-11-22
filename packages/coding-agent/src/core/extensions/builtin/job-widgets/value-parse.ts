/**
 * Numbers as job output writes them: `41.3`, `1,250`, `1.5k`, `2104.32M`.
 * Ported from oh-my-pi 9df0457b31 (MIT, Copyright Can Boluk et al.).
 */

const NUMBER_PREFIX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const SUFFIX_SCALE: Readonly<Record<string, number>> = { k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
/** A number as text writes it: digits with separators, a fraction, a `k`/`M`/`G` suffix. */
const WRITTEN_NUMBER = /\d[\d,_]*(?:\.\d+)?[kKMG]?/g;

/**
 * A captured number: `,`/`_` separators dropped, a `k`/`K`/`M`/`G` suffix right after the digits
 * multiplies; `NaN` when the text starts with no number.
 */
export function parseWidgetValue(text: string): number {
	// Hot path: a plain decimal needs no cleanup. `Number` would also read `0x1f` and `0b1` as hex
	// and binary, so a second character that could start a radix prefix takes the slow path.
	const first = text.charCodeAt(0);
	if (first >= 48 && first <= 57 && !/[xXbBoO]/.test(text.charAt(1))) {
		const plain = Number(text);
		if (Number.isFinite(plain)) return plain;
	}
	const compact = text.trim().replace(/[,_]/g, "");
	const match = NUMBER_PREFIX.exec(compact);
	if (!match) return Number.NaN;
	const value = Number.parseFloat(match[0]);
	return value * (SUFFIX_SCALE[compact.charAt(match[0].length)] ?? 1);
}

/** Every number `text` states, parsed as {@link parseWidgetValue} reads it. */
export function statedNumbers(texts: Iterable<string>): Set<number> {
	const stated = new Set<number>();
	for (const text of texts) {
		for (const match of text.matchAll(WRITTEN_NUMBER)) stated.add(parseWidgetValue(match[0]));
	}
	return stated;
}
