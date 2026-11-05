/**
 * A POSIX extended regular expression reader, independent of the host's regex engine (senpi#5349). It answers the
 * three questions the kill guard asks of a `pkill`/`killall` pattern: does some alternative branch match nothing at
 * all, can the whole pattern match the empty string, and how few literal characters can a match carry. glibc
 * compiles `a||b` to "matches every line" while BSD libc rejects it, so the guard reads patterns itself.
 *
 * Grammar: alternation, groups, bracket expressions (classes, equivalence classes, collating symbols, negation),
 * `*` `+` `?` `{m}` `{m,}` `{m,n}`, anchors `^` `$`, and the glibc/BSD escapes: `\w \W \s \S \d \D` match one
 * arbitrary character, `\b \B \< \> \` \'` are zero width, any other escaped character is that literal.
 */

export type PatternReading =
	| { readonly kind: "unparsable"; readonly why: string }
	| {
			readonly kind: "parsed";
			/** Some alternative branch, at any group level, is empty (`a||b`, `(|x)`, `()`). */
			readonly emptyBranch: boolean;
			/** The whole pattern can match the empty string. */
			readonly nullable: boolean;
			/** The fewest literal characters any match path carries. */
			readonly minLiterals: number;
	  };

interface Shape {
	readonly nullable: boolean;
	readonly minLiterals: number;
}

class Unreadable extends Error {}

const ANY_CHAR_ESCAPES = new Set(["w", "W", "s", "S", "d", "D"]);
const ZERO_WIDTH_ESCAPES = new Set(["b", "B", "<", ">", "`", "'"]);
const MAX_PATTERN_LENGTH = 4096;
const MAX_DEPTH = 64;

class Reader {
	private index = 0;
	emptyBranch = false;
	private readonly source: string;

	constructor(source: string) {
		this.source = source;
	}

	read(): Shape {
		const shape = this.alternation(0);
		if (this.index < this.source.length) throw new Unreadable(`unbalanced ")" at offset ${this.index}`);
		return shape;
	}

	private alternation(depth: number): Shape {
		if (depth > MAX_DEPTH) throw new Unreadable("nested too deeply");
		const branches = [this.branch(depth)];
		while (this.source[this.index] === "|") {
			this.index += 1;
			branches.push(this.branch(depth));
		}
		return {
			nullable: branches.some((branch) => branch.nullable),
			minLiterals: Math.min(...branches.map((branch) => branch.minLiterals)),
		};
	}

	private branch(depth: number): Shape {
		let nullable = true;
		let minLiterals = 0;
		let pieces = 0;
		while (this.index < this.source.length) {
			const char = this.source[this.index];
			if (char === "|" || char === ")") break;
			const piece = this.piece(depth);
			pieces += 1;
			nullable &&= piece.nullable;
			minLiterals += piece.minLiterals;
		}
		if (pieces === 0) this.emptyBranch = true;
		return { nullable, minLiterals };
	}

	private piece(depth: number): Shape {
		let shape = this.atom(depth);
		for (;;) {
			const char = this.source[this.index];
			if (char === "*" || char === "?") {
				this.index += 1;
				shape = { nullable: true, minLiterals: 0 };
				continue;
			}
			if (char === "+") {
				this.index += 1;
				continue;
			}
			if (char === "{") {
				const minimum = this.interval();
				shape =
					minimum === 0
						? { nullable: true, minLiterals: 0 }
						: { ...shape, minLiterals: shape.minLiterals * minimum };
				continue;
			}
			return shape;
		}
	}

	/** Reads `{m}`, `{m,}` or `{m,n}` and returns `m`; anything else after `{` is a bad interval. */
	private interval(): number {
		const match = /^\{(\d+)(,(\d*))?\}/.exec(this.source.slice(this.index));
		if (match === null) throw new Unreadable(`bad interval at offset ${this.index}`);
		const minimum = Number(match[1]);
		const maximum = match[3] === undefined ? minimum : match[3] === "" ? Number.POSITIVE_INFINITY : Number(match[3]);
		if (minimum > maximum) throw new Unreadable(`bad interval at offset ${this.index}`);
		this.index += match[0].length;
		return minimum;
	}

	private atom(depth: number): Shape {
		const char = this.source[this.index];
		if (char === "*" || char === "+" || char === "?" || char === "{") {
			throw new Unreadable(`"${char}" at offset ${this.index} repeats nothing`);
		}
		if (char === "(") {
			this.index += 1;
			const inner = this.alternation(depth + 1);
			if (this.source[this.index] !== ")") throw new Unreadable('unbalanced "("');
			this.index += 1;
			return inner;
		}
		if (char === "[") {
			this.bracket();
			return { nullable: false, minLiterals: 0 };
		}
		if (char === "^" || char === "$") {
			this.index += 1;
			return { nullable: true, minLiterals: 0 };
		}
		if (char === ".") {
			this.index += 1;
			return { nullable: false, minLiterals: 0 };
		}
		if (char === "\\") {
			const escaped = this.source[this.index + 1];
			if (escaped === undefined) throw new Unreadable("trailing backslash");
			this.index += 2;
			if (ANY_CHAR_ESCAPES.has(escaped)) return { nullable: false, minLiterals: 0 };
			if (ZERO_WIDTH_ESCAPES.has(escaped)) return { nullable: true, minLiterals: 0 };
			return { nullable: false, minLiterals: 1 };
		}
		this.index += 1;
		return { nullable: false, minLiterals: 1 };
	}

	/** Skips a bracket expression starting at `[`; a `]` right after `[` or `[^` is a member, not the end. */
	private bracket(): void {
		let index = this.index + 1;
		if (this.source[index] === "^") index += 1;
		if (this.source[index] === "]") index += 1;
		while (index < this.source.length) {
			const char = this.source[index];
			if (char === "]") {
				this.index = index + 1;
				return;
			}
			if (char === "[" && ":=.".includes(this.source[index + 1] ?? "")) {
				const delimiter = this.source[index + 1];
				const close = this.source.indexOf(`${delimiter}]`, index + 2);
				if (close < 0) throw new Unreadable(`unterminated "[${delimiter}"`);
				index = close + 2;
				continue;
			}
			index += 1;
		}
		throw new Unreadable('unbalanced "["');
	}
}

export function readPattern(pattern: string): PatternReading {
	if (pattern.length > MAX_PATTERN_LENGTH) return { kind: "unparsable", why: "it is too long to read" };
	const reader = new Reader(pattern);
	try {
		const shape = reader.read();
		return {
			kind: "parsed",
			emptyBranch: reader.emptyBranch,
			nullable: shape.nullable,
			minLiterals: shape.minLiterals,
		};
	} catch (error) {
		if (error instanceof Unreadable) return { kind: "unparsable", why: error.message };
		throw error;
	}
}
