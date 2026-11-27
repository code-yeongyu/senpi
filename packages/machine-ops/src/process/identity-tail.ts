import { MAX_GAP, NAME, normalize } from "./identity-text.ts";

const TAIL = 1024;
const NAMES = [
	"signing",
	"sealing",
	"signing_private_key",
	"sealing_private_key",
	"signingprivatekey",
	"sealingprivatekey",
];
const PRIVATE_TAIL = new RegExp(
	`(?<!\\w)${NAME}(["']?\\s{0,${MAX_GAP}}[:=\\t]?\\s{0,${MAX_GAP}}["']?)([a-z\\d+/_=-]{1,128}|\\[[\\d,\\s]{0,1024})?$`,
	"i",
);
const TOKEN_TAIL = /(?:tvk1:[a-z\d_=-]|age-secret-key-1[a-z\d])[a-z\d_=-]*$/i;

const HUMAN_KEYS = ["secretKey", "sealedKey"];

/** Start of a quoted human-record key name still being written. A whole key and the gap after it
 * are public and released; the stream's parser state keeps the record awaiting its value. */
function humanKeyTail(text: string, floor: number): number | undefined {
	const from = Math.max(floor, text.length - 128);
	const { view, at } = normalize(text.slice(from));
	const partial = /["']([A-Za-z]{0,9})$/.exec(view);
	if (!partial || !HUMAN_KEYS.some((k) => k.startsWith(partial[1]))) return undefined;
	return from + (at ? at[partial.index] : partial.index);
}

/** Where the undecided tail of `text` starts: a partial escape, a token prefix, a private
 * name with its separator and an unterminated value, or a partial human-record key. `value`
 * is the start of an unterminated private value, which an ending stream masks. */
export function undecidedTail(text: string, floor: number): { start: number; value?: number; keep?: boolean } {
	let from = Math.max(floor, text.length - TAIL);
	while (from > floor && text.charCodeAt(from - 1) === 92) from--;
	const tail = text.slice(from);
	const { view, at } = normalize(tail);
	const raw = (v: number) => from + (at ? at[v] : v);
	let start = text.length;
	let value: number | undefined;
	const escape = /\\+(?:u[\da-f]{0,4})?$/i.exec(tail);
	if (escape) start = from + escape.index;
	const humanKey = humanKeyTail(text, floor);
	if (humanKey !== undefined) start = Math.min(start, humanKey);
	// An idle pause may release a public name prefix, never a key or an escape still being decided.
	const keep = humanKey !== undefined || !!escape;
	// A token already past its prefix is masked now; the stream discards the rest of its body.
	if (!escape && TOKEN_TAIL.test(view)) return { start, keep };
	const lower = view.slice(-24).toLowerCase();
	for (let i = 0; i < lower.length; i++) {
		const rest = lower.slice(i);
		const boundary = !/\w/.test(view.charAt(view.length - rest.length - 1));
		const token = ["tvk1:", "age-secret-key-1"].some((p) => p.startsWith(rest));
		if (boundary && (token || NAMES.some((p) => p.startsWith(rest)))) {
			start = Math.min(start, raw(view.length - rest.length));
			break;
		}
	}
	const field = PRIVATE_TAIL.exec(view);
	if (field) {
		start = Math.min(start, raw(field.index));
		if (/[:=\t]/.test(field[1] ?? "") && field[2]) value = raw(view.length - field[2].length);
	}
	return { start, value, keep };
}
