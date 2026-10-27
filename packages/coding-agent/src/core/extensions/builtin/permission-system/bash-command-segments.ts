/**
 * Splits a shell command into the simple commands it would run, so the `bash` permission decision
 * can judge every one of them, not only the first.
 *
 * The lexer follows bash's word and operator rules closely enough to find each simple command:
 * `;`, `&&`, `||`, `|`, `|&`, `&` and line breaks end one; subshells `( … )`, command substitution
 * `$( … )` and backticks, process substitution `<( … )` / `>( … )`, `${ … }` and `$(( … ))` and the
 * bodies of unquoted here-documents are searched for the commands they run; redirections and their
 * targets are dropped. Every command name is then normalized: leading assignments and reserved
 * words are skipped, a path is reduced to its basename, and a wrapper (`env`, `sudo`, `xargs`,
 * `bash -c`, `find -exec`, …) yields both its own name and the command it runs.
 *
 * Anything the lexer does not understand (an unterminated quote, a `case`, a function definition,
 * a command name built by an expansion, an unknown wrapper option) makes the whole command
 * `unparsed`, and the caller must not let any command-specific rule allow it.
 */

export type BashCommandAnalysis =
	| { readonly kind: "parsed"; readonly segments: readonly (readonly string[])[] }
	| { readonly kind: "unparsed" };

interface Word {
	text: string;
	/** Part of the word comes from an expansion or a glob, so its runtime value is unknown. */
	dynamic: boolean;
	/** Part of the word was quoted or escaped, so it is never a reserved word or an operator. */
	quoted: boolean;
	/** Length of the leading text that is plain (no quote, escape or expansion): only it can name an assignment. */
	plainPrefix: number;
	plainEnded: boolean;
	/** An unquoted `{` that brace expansion may turn into several words. */
	brace: boolean;
	/** An unquoted `*`, `?` or `[` that pathname expansion may replace. */
	glob: boolean;
}

class Unparsed extends Error {}

const MAX_DEPTH = 12;
/** Longer commands are not lexed at all: they are `unparsed`, so only a `*` rule can decide them. */
export const MAX_COMMAND_LENGTH = 64 * 1024;
/** Total characters the lexer may visit across every nested scan of one command before giving up. */
const MAX_STEPS = 4_000_000;
/** Words a best-effort candidate needs: the longest `BashArity` prefix is three words. */
const CANDIDATE_WORDS = 3;

// Module state, safe because `analyzeBashCommand` is synchronous and never re-enters itself.
let steps = 0;
/** Counts lexer work; overrunning the budget makes the command `unparsed`, never slow. */
const step = (count = 1) => {
	steps += count;
	if (steps > MAX_STEPS) fail();
};

const fail = (): never => {
	throw new Unparsed();
};

const isDigits = (text: string) => /^[0-9]+$/.test(text);
const NAME_CHAR = /[A-Za-z0-9_]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/** A leading `NAME=value` word, decided on its plain prefix as bash decides it before expansion. */
const isAssignment = (word: Word): boolean => {
	const match = ASSIGNMENT.exec(word.text);
	return match !== null && match[0].length <= word.plainPrefix;
};

/** Index just past the `)` that closes a `(` opened right before `start`, skipping quoted text. */
function matchParen(source: string, start: number): number {
	let depth = 1;
	let index = start;
	while (index < source.length) {
		step();
		const char = source[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "'") {
			const end = source.indexOf("'", index + 1);
			if (end < 0) fail();
			index = end + 1;
			continue;
		}
		if (char === '"') {
			index = skipDoubleQuoted(source, index + 1);
			continue;
		}
		if (char === "`") {
			index = skipBackticks(source, index + 1);
			continue;
		}
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
		index += 1;
	}
	return fail();
}

/** Index just past the closing `"` of a double-quoted string that starts at `start`. */
function skipDoubleQuoted(source: string, start: number): number {
	let index = start;
	while (index < source.length) {
		step();
		const char = source[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === '"') return index + 1;
		if (char === "`") {
			index = skipBackticks(source, index + 1);
			continue;
		}
		if (char === "$" && source[index + 1] === "(") {
			index = matchParen(source, index + 2);
			continue;
		}
		index += 1;
	}
	return fail();
}

/** Index just past the closing backtick of a backtick substitution that starts at `start`. */
function skipBackticks(source: string, start: number): number {
	let index = start;
	while (index < source.length) {
		step();
		const char = source[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "`") return index + 1;
		index += 1;
	}
	return fail();
}

/** Index just past the `}` closing a `${` whose body starts at `start`. */
function matchBrace(source: string, start: number): number {
	let depth = 1;
	let index = start;
	while (index < source.length) {
		step();
		const char = source[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "'") {
			const end = source.indexOf("'", index + 1);
			if (end < 0) fail();
			index = end + 1;
			continue;
		}
		if (char === '"') {
			index = skipDoubleQuoted(source, index + 1);
			continue;
		}
		if (char === "`") {
			index = skipBackticks(source, index + 1);
			continue;
		}
		if (char === "$" && source[index + 1] === "(") {
			index = matchParen(source, index + 2);
			continue;
		}
		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
		index += 1;
	}
	return fail();
}

/**
 * Whether the `((` whose first `(` is at `open` is arithmetic: its inner `(` must close right before the
 * outer one. Otherwise bash reads it as a command substitution or subshell that starts with a subshell.
 */
function isArithmetic(source: string, open: number): boolean {
	const outerEnd = matchParen(source, open + 1);
	const innerEnd = matchParen(source, open + 2);
	return innerEnd === outerEnd - 1;
}

/** The unescaped body of a backtick substitution (bash removes `\` before `$`, `` ` `` and `\`). */
function unescapeBackticks(body: string): string {
	return body.replace(/\\([$`\\])/g, "$1");
}

interface PendingHeredoc {
	readonly delimiter: string;
	readonly expands: boolean;
	readonly stripTabs: boolean;
}

/**
 * The lexer for one command list. `segments` collects every simple command found, in source order,
 * including the ones found inside substitutions.
 */
class Lexer {
	private index = 0;
	private word: Word | undefined;
	private words: Word[] = [];
	private redirectNext: { heredoc?: { stripTabs: boolean } } | undefined;
	private pendingHeredocs: PendingHeredoc[] = [];
	private inDoubleBracket = false;
	private readonly source: string;
	private readonly depth: number;
	private readonly segments: Word[][];

	constructor(source: string, depth: number, segments: Word[][]) {
		if (depth > MAX_DEPTH) fail();
		this.source = source;
		this.depth = depth;
		this.segments = segments;
	}

	run(): void {
		const source = this.source;
		while (this.index < source.length) {
			step();
			const char = source[this.index];
			if (this.word === undefined && char === "#") {
				while (this.index < source.length && source[this.index] !== "\n") this.index += 1;
				continue;
			}
			if (char === " " || char === "\t") {
				this.endWord();
				this.index += 1;
				continue;
			}
			if (char === "\n") {
				this.endSegment();
				this.index += 1;
				this.readHeredocBodies();
				continue;
			}
			if (char === "\\") {
				if (source[this.index + 1] === "\n") {
					this.index += 2;
					continue;
				}
				if (this.index + 1 >= source.length) fail();
				this.append(source[this.index + 1], { quoted: true });
				this.index += 2;
				continue;
			}
			if (char === "'") {
				const end = source.indexOf("'", this.index + 1);
				if (end < 0) fail();
				this.append(source.slice(this.index + 1, end), { quoted: true });
				this.index = end + 1;
				continue;
			}
			if (char === '"') {
				this.readDoubleQuoted();
				continue;
			}
			if (char === "`") {
				const end = skipBackticks(source, this.index + 1);
				this.nested(unescapeBackticks(source.slice(this.index + 1, end - 1)));
				this.append("", { dynamic: true });
				this.index = end;
				continue;
			}
			if (char === "$") {
				this.readDollar();
				continue;
			}
			if (this.inDoubleBracket && !(this.word !== undefined && !this.word.quoted && this.word.text === "]]")) {
				this.append(char, {});
				this.index += 1;
				continue;
			}
			if ((char === "<" || char === ">") && source[this.index + 1] === "(" && this.word === undefined) {
				const end = matchParen(source, this.index + 2);
				this.nested(source.slice(this.index + 2, end - 1));
				this.append("", { dynamic: true });
				this.index = end;
				continue;
			}
			if (char === "<" || char === ">") {
				this.readRedirection();
				continue;
			}
			if (char === "&") {
				if (source[this.index + 1] === ">") {
					this.endWord();
					this.index += source[this.index + 2] === ">" ? 3 : 2;
					this.redirectNext = {};
					continue;
				}
				this.endSegment();
				this.index += source[this.index + 1] === "&" ? 2 : 1;
				continue;
			}
			if (char === "|") {
				this.endSegment();
				this.index += source[this.index + 1] === "|" || source[this.index + 1] === "&" ? 2 : 1;
				continue;
			}
			if (char === ";") {
				if (source[this.index + 1] === ";" || source[this.index + 1] === "&") fail();
				this.endSegment();
				this.index += 1;
				continue;
			}
			if (char === "(") {
				this.readOpenParen();
				continue;
			}
			if (char === ")") fail();
			this.append(char, {});
			if (this.word !== undefined && char === "{") this.word.brace = true;
			if (this.word !== undefined && (char === "*" || char === "?" || char === "[")) this.word.glob = true;
			this.index += 1;
		}
		this.endSegment();
		// A here-document with no line after it has an empty body; there is nothing left to run.
		this.pendingHeredocs = [];
	}

	private append(text: string, flags: { dynamic?: boolean; quoted?: boolean }): void {
		if (this.word === undefined) {
			this.word = {
				text: "",
				dynamic: false,
				quoted: false,
				plainPrefix: 0,
				plainEnded: false,
				brace: false,
				glob: false,
			};
		}
		const word = this.word;
		word.text += text;
		if (flags.dynamic) word.dynamic = true;
		if (flags.quoted) word.quoted = true;
		if (flags.dynamic || flags.quoted) word.plainEnded = true;
		if (!word.plainEnded) word.plainPrefix = word.text.length;
	}

	private nested(source: string): void {
		new Lexer(source, this.depth + this.textDepth + 1, this.segments).run();
	}

	private endWord(): void {
		const word = this.word;
		this.word = undefined;
		if (word === undefined) return;
		// Only `{a,b}` and `{1..3}` expand; `{}` (find's placeholder) and `{x}` stay literal.
		if (word.brace && /\{[^}]*(,|\.\.)[^}]*\}/.test(word.text)) word.dynamic = true;
		// `[` and `[[` are the test command and keyword, not a pattern.
		if (word.glob && word.text !== "[" && word.text !== "[[") word.dynamic = true;
		if (this.redirectNext !== undefined) {
			const heredoc = this.redirectNext.heredoc;
			this.redirectNext = undefined;
			if (heredoc !== undefined) {
				if (word.dynamic) fail();
				this.pendingHeredocs.push({ delimiter: word.text, expands: !word.quoted, stripTabs: heredoc.stripTabs });
			}
			return;
		}
		if (
			!word.quoted &&
			word.text === "[[" &&
			this.words.every((leader) => !leader.quoted && RESERVED_LEADERS.has(leader.text))
		) {
			this.inDoubleBracket = true;
		}
		if (!word.quoted && word.text === "]]" && this.inDoubleBracket) this.inDoubleBracket = false;
		this.words.push(word);
	}

	private endSegment(): void {
		this.endWord();
		// A redirection operator with no target is a syntax error; bash runs nothing.
		if (this.redirectNext !== undefined) fail();
		if (this.inDoubleBracket) fail();
		if (this.words.length > 0) this.segments.push(this.words);
		this.words = [];
	}

	private readDoubleQuoted(): void {
		const source = this.source;
		this.append("", { quoted: true });
		this.index += 1;
		while (this.index < source.length) {
			const char = source[this.index];
			if (char === '"') {
				this.index += 1;
				return;
			}
			if (char === "\\") {
				const next = source[this.index + 1];
				if (next === undefined) fail();
				if (next === "\n") {
					this.index += 2;
					continue;
				}
				this.append('$`"\\'.includes(next) ? next : `\\${next}`, {});
				this.index += 2;
				continue;
			}
			if (char === "`") {
				const end = skipBackticks(source, this.index + 1);
				this.nested(unescapeBackticks(source.slice(this.index + 1, end - 1)));
				this.append("", { dynamic: true });
				this.index = end;
				continue;
			}
			if (char === "$") {
				this.readDollar();
				continue;
			}
			this.append(char, {});
			this.index += 1;
		}
		fail();
	}

	/** `$…` in or out of double quotes: substitutions are searched, every expansion is dynamic. */
	private readDollar(): void {
		const source = this.source;
		const next = source[this.index + 1];
		if (next === "(" && source[this.index + 2] === "(" && isArithmetic(source, this.index + 1)) {
			const end = matchParen(source, this.index + 2);
			this.nestedText(source.slice(this.index + 3, end - 2));
			this.append("", { dynamic: true });
			this.index = end;
			return;
		}
		if (next === "(") {
			const end = matchParen(source, this.index + 2);
			this.nested(source.slice(this.index + 2, end - 1));
			this.append("", { dynamic: true });
			this.index = end;
			return;
		}
		if (next === "{") {
			const end = matchBrace(source, this.index + 2);
			this.nestedText(source.slice(this.index + 2, end - 1));
			this.append("", { dynamic: true });
			this.index = end;
			return;
		}
		if (next === "'") {
			// ANSI-C quoting decodes escapes, so its value is unknown to this lexer.
			let index = this.index + 2;
			while (index < source.length && source[index] !== "'") index += source[index] === "\\" ? 2 : 1;
			if (index >= source.length) fail();
			this.append("", { dynamic: true, quoted: true });
			this.index = index + 1;
			return;
		}
		if (next !== undefined && (NAME_CHAR.test(next) || "@*#?$!-".includes(next))) {
			let index = this.index + 1;
			if (NAME_CHAR.test(next) && !/[0-9]/.test(next)) {
				while (index < source.length && NAME_CHAR.test(source[index])) index += 1;
			} else {
				index += 1;
			}
			this.append("", { dynamic: true });
			this.index = index;
			return;
		}
		this.append("$", {});
		this.index += 1;
	}

	/** Searches text that is not a command list (a `${…}` body, a here-document) for substitutions. */
	private textDepth = 0;

	private nestedText(text: string): void {
		this.textDepth += 1;
		if (this.depth + this.textDepth > MAX_DEPTH) fail();
		try {
			this.scanText(text);
		} finally {
			this.textDepth -= 1;
		}
	}

	private scanText(text: string): void {
		let index = 0;
		while (index < text.length) {
			const char = text[index];
			if (char === "\\") {
				index += 2;
				continue;
			}
			if (char === "`") {
				const end = skipBackticks(text, index + 1);
				this.nested(unescapeBackticks(text.slice(index + 1, end - 1)));
				index = end;
				continue;
			}
			if (char === "$" && text[index + 1] === "(") {
				const end = matchParen(text, index + 2);
				if (text[index + 2] === "(" && isArithmetic(text, index + 1))
					this.nestedText(text.slice(index + 3, end - 2));
				else this.nested(text.slice(index + 2, end - 1));
				index = end;
				continue;
			}
			if (char === "$" && text[index + 1] === "{") {
				const end = matchBrace(text, index + 2);
				this.nestedText(text.slice(index + 2, end - 1));
				index = end;
				continue;
			}
			index += 1;
		}
	}

	private readRedirection(): void {
		const source = this.source;
		const word = this.word;
		// A word made only of digits right before the operator is a file descriptor, not an argument.
		if (word !== undefined && !word.quoted && !word.dynamic && isDigits(word.text)) {
			this.word = undefined;
		} else {
			this.endWord();
		}
		const char = source[this.index];
		const next = source[this.index + 1];
		if (char === "<" && next === "<" && source[this.index + 2] === "<") {
			this.index += 3;
			this.redirectNext = {};
			return;
		}
		if (char === "<" && next === "<") {
			const stripTabs = source[this.index + 2] === "-";
			this.index += stripTabs ? 3 : 2;
			this.redirectNext = { heredoc: { stripTabs } };
			return;
		}
		this.index += 1;
		if (char === ">" && (next === ">" || next === "|" || next === "&")) this.index += 1;
		else if (char === "<" && (next === ">" || next === "&")) this.index += 1;
		this.redirectNext = {};
	}

	private readOpenParen(): void {
		const source = this.source;
		const word = this.word;
		if (word !== undefined) {
			// `name=( … )` is an array assignment; any other `word(` is a function definition or a syntax error.
			if (word.quoted || !/^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(word.text)) fail();
			const end = matchParen(source, this.index + 1);
			this.nestedText(source.slice(this.index + 1, end - 1));
			this.append("", { dynamic: true });
			this.index = end;
			return;
		}
		if (source[this.index + 1] === "(" && isArithmetic(source, this.index)) {
			const end = matchParen(source, this.index + 1);
			this.nestedText(source.slice(this.index + 2, end - 2));
			this.index = end;
			return;
		}
		const end = matchParen(source, this.index + 1);
		this.endSegment();
		this.nested(source.slice(this.index + 1, end - 1));
		this.index = end;
	}

	private readHeredocBodies(): void {
		const source = this.source;
		for (const heredoc of this.pendingHeredocs) {
			const body: string[] = [];
			for (;;) {
				if (this.index >= source.length) break;
				const lineEnd = source.indexOf("\n", this.index);
				const end = lineEnd < 0 ? source.length : lineEnd;
				const raw = source.slice(this.index, end);
				this.index = lineEnd < 0 ? source.length : lineEnd + 1;
				const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
				if (line === heredoc.delimiter) break;
				body.push(line);
			}
			if (heredoc.expands) this.nestedText(body.join("\n"));
		}
		this.pendingHeredocs = [];
	}
}

const RESERVED_LEADERS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until"]);
const UNSUPPORTED_LEADERS = new Set(["case", "esac", "function", "coproc"]);
const LOOP_HEADERS = new Set(["for", "select"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "yash", "posh", "fish", "csh", "tcsh"]);

type Expand = (words: readonly Word[], out: string[][]) => void;

/** Options a wrapper takes: `true` = a flag alone, `"value"` = a flag followed by one value. */
type OptionTable = Readonly<Record<string, true | "value">>;

const opts = (flags: string, values = ""): OptionTable => ({
	...Object.fromEntries(
		flags
			.split(" ")
			.filter(Boolean)
			.map((name) => [name, true as const]),
	),
	...Object.fromEntries(
		values
			.split(" ")
			.filter(Boolean)
			.map((name) => [name, "value" as const]),
	),
});

/**
 * Skips a wrapper's options and returns the index of the wrapped command's first word, or
 * `words.length` when there is none. An option the table does not list makes the command unparsed:
 * guessing whether it takes a value could hide the wrapped command.
 */
function skipOptions(words: readonly Word[], start: number, table: OptionTable): number {
	let index = start;
	while (index < words.length) {
		const word = words[index];
		if (word.dynamic) fail();
		const text = word.text;
		if (text === "--") return index + 1;
		if (!text.startsWith("-") || text === "-") return index;
		if (text.startsWith("--")) {
			const separator = text.indexOf("=");
			const name = separator < 0 ? text : text.slice(0, separator);
			const kind = table[name];
			if (kind === undefined) fail();
			index += kind === "value" && separator < 0 ? 2 : 1;
			continue;
		}
		if (table[text] === "value") {
			index += 2;
			continue;
		}
		if (table[text] === true) {
			index += 1;
			continue;
		}
		// A cluster of single-letter flags (`-lc`), where only the last may take a value (`-un`).
		const letters = text.slice(1).split("");
		let consumed = 1;
		for (const [position, letter] of letters.entries()) {
			const kind = table[`-${letter}`];
			if (kind === undefined) {
				// Numeric options such as `nice -5`.
				if (/^-[0-9]+$/.test(text) && table["-N"] === true) break;
				fail();
			}
			if (kind === "value") {
				if (position === letters.length - 1) consumed = 2;
				break;
			}
		}
		index += consumed;
	}
	return index;
}

const WRAPPER_OPTIONS: Readonly<Record<string, OptionTable>> = {
	command: opts("-p -v -V"),
	builtin: opts(""),
	exec: opts("-c -l", "-a"),
	nohup: opts(""),
	time: opts("-p -l -v -a --portability --verbose --append", "-o -f --output --format"),
	nice: opts("-N", "-n --adjustment"),
	stdbuf: opts("", "-i -o -e --input --output --error"),
	caffeinate: opts("-d -i -m -s -u", "-t -w"),
	sudo: opts(
		"-A -b -E -H -K -k -n -P -S -V -v --askpass --background --preserve-env --set-home --non-interactive --stdin",
		"-u -g -h -p -C -D -r -t -U -T --user --group --host --prompt --close-from --chdir --role --type --other-user --command-timeout",
	),
	doas: opts("-n -s", "-u -C"),
	setsid: opts("-c -f -w --ctty --fork --wait"),
	ionice: opts("-t --ignore", "-c -n --class --classdata"),
};

const ENV_OPTIONS = opts("-i -0 -v --ignore-environment --null --debug", "-u -C --unset --chdir");
const TIMEOUT_OPTIONS = opts("-v --preserve-status --foreground --verbose", "-s -k --signal --kill-after");
const XARGS_OPTIONS = opts(
	"-0 -r -t -p -x -o --null --no-run-if-empty --verbose --interactive --exit --open-tty",
	"-I -L -n -P -s -d -E -a --max-lines --max-args --max-procs --max-chars --delimiter --eof --arg-file --replace --process-slot-var",
);
const SHELL_OPTIONS = opts(
	"-e -u -x -v -f -n -l -i -s -p -a -b -h -k -m -B -C -E -H -P -T --login --norc --noprofile --posix --restricted --noediting -c",
	"-o -O --rcfile --init-file",
);

const pathBasename = (text: string) => {
	const parts = text.split("/");
	return parts[parts.length - 1] ?? text;
};

/**
 * Turns one simple command's words into the command lines it runs: the wrapper's own name first,
 * then the wrapped command, recursively. Every name is reduced to its basename.
 */
const expandSimpleCommand: Expand = (input, out) => {
	let words = input;
	// Leading assignments and reserved words do not name the command.
	let start = 0;
	while (start < words.length) {
		const word = words[start];
		if (!word.quoted && RESERVED_LEADERS.has(word.text)) {
			start += 1;
			continue;
		}
		if (!word.quoted && UNSUPPORTED_LEADERS.has(word.text)) fail();
		if (isAssignment(word)) {
			start += 1;
			continue;
		}
		break;
	}
	words = words.slice(start);
	const first = words[0];
	if (first === undefined) return;
	if (!first.quoted && LOOP_HEADERS.has(first.text)) {
		// `for NAME [in WORDS]` and `for (( … ))` run nothing themselves; substitutions in them were already found.
		if (words.length === 1 || words.length === 2 || words[2]?.text === "in") return;
		fail();
	}
	if (first.dynamic || first.text === "") fail();
	const name = pathBasename(first.text);
	if (name === "") fail();
	const rest = words.slice(1);
	const line = [name, ...rest.map((word) => word.text)];

	if (SHELLS.has(name)) {
		out.push([name]);
		const commandIndex = shellCommandIndex(rest);
		if (commandIndex === undefined) {
			out.push(line);
			return;
		}
		const script = rest[commandIndex];
		if (script === undefined || script.dynamic) fail();
		for (const segment of lexSegments(script.text)) expandSimpleCommand(segment, out);
		return;
	}
	if (name === "eval") {
		out.push([name]);
		if (rest.some((word) => word.dynamic)) fail();
		const args = rest[0]?.text === "--" ? rest.slice(1) : rest;
		for (const segment of lexSegments(args.map((word) => word.text).join(" "))) expandSimpleCommand(segment, out);
		return;
	}
	if (name === "su") {
		out.push([name]);
		const script = suCommand(rest);
		if (script === undefined) return;
		for (const segment of lexSegments(script)) expandSimpleCommand(segment, out);
		return;
	}
	if (name === "trap") {
		out.push([name]);
		const scriptIndex = rest.findIndex((word) => !word.text.startsWith("-"));
		const script = scriptIndex < 0 ? undefined : rest[scriptIndex];
		if (script === undefined) return;
		if (script.dynamic) fail();
		for (const segment of lexSegments(script.text)) expandSimpleCommand(segment, out);
		return;
	}
	if (name === "env") {
		out.push([name]);
		if (rest.some((word) => !word.dynamic && (word.text === "-S" || word.text.startsWith("--split-string")))) fail();
		let index = skipOptions(rest, 0, ENV_OPTIONS);
		// env itself, not the shell, reads these: any NAME=VALUE word, quoted or not, is an assignment.
		while (index < rest.length && !rest[index].dynamic && /^[^=]+=/.test(rest[index].text)) index += 1;
		expandSimpleCommand(rest.slice(index), out);
		return;
	}
	if (name === "timeout") {
		out.push([name]);
		const index = skipOptions(rest, 0, TIMEOUT_OPTIONS);
		// The first operand is the duration.
		expandSimpleCommand(rest.slice(index + 1), out);
		return;
	}
	if (name === "xargs") {
		out.push([name]);
		expandSimpleCommand(rest.slice(skipOptions(rest, 0, XARGS_OPTIONS)), out);
		return;
	}
	if (name === "find") {
		out.push(line);
		// find reads its words after quote removal, so a quoted action is still an action.
		if (rest.some((word) => word.dynamic)) fail();
		for (let index = 0; index < rest.length; index += 1) {
			if (!["-exec", "-execdir", "-ok", "-okdir"].includes(rest[index].text)) continue;
			let end = index + 1;
			while (end < rest.length && rest[end].text !== ";" && rest[end].text !== "+") end += 1;
			if (end >= rest.length) fail();
			expandSimpleCommand(rest.slice(index + 1, end), out);
			index = end;
		}
		return;
	}
	const wrapperOptions = WRAPPER_OPTIONS[name];
	if (wrapperOptions !== undefined) {
		out.push([name]);
		expandSimpleCommand(rest.slice(skipOptions(rest, 0, wrapperOptions)), out);
		return;
	}
	out.push(line);
};

/** The command string `su` runs (`-c`, `--command`, `--session-command`, or `c` in a flag cluster), if any. */
function suCommand(rest: readonly Word[]): string | undefined {
	for (let index = 0; index < rest.length; index += 1) {
		const word = rest[index];
		const text = word.text;
		const long = /^--(session-)?command(=|$)/.exec(text);
		if (long) {
			const value = long[2] === "=" ? text.slice(long[0].length) : rest[index + 1]?.text;
			const source = long[2] === "=" ? word : rest[index + 1];
			if (value === undefined || source === undefined || source.dynamic) fail();
			return value;
		}
		if (/^-[A-Za-z]*c/.test(text) && !text.startsWith("--")) {
			const attached = text.slice(text.indexOf("c") + 1);
			const source = attached === "" ? rest[index + 1] : word;
			if (source === undefined || source.dynamic) fail();
			return attached === "" ? source.text : attached;
		}
	}
	return undefined;
}

/** The index (in `rest`) of a shell's `-c` command string, or undefined when it reads a file or stdin. */
function shellCommandIndex(rest: readonly Word[]): number | undefined {
	let index = 0;
	let hasCommandFlag = false;
	while (index < rest.length) {
		const word = rest[index];
		if (word.dynamic) fail();
		const text = word.text;
		if (text === "--" || text === "-") {
			index += 1;
			break;
		}
		if (!text.startsWith("-") && !text.startsWith("+")) break;
		if (text.startsWith("--")) {
			const kind = SHELL_OPTIONS[text.split("=")[0]];
			if (kind === undefined) fail();
			index += kind === "value" && !text.includes("=") ? 2 : 1;
			continue;
		}
		const letters = text.slice(1);
		if (letters.includes("c")) hasCommandFlag = true;
		for (const letter of letters) if (SHELL_OPTIONS[`-${letter}`] === undefined) fail();
		index += letters.includes("o") || letters.includes("O") ? 2 : 1;
	}
	return hasCommandFlag ? index : undefined;
}

function lexSegments(command: string): Word[][] {
	const segments: Word[][] = [];
	new Lexer(command, 0, segments).run();
	return segments;
}

/**
 * Every simple command `command` would run, each as its normalized words (command name first), in
 * source order; or `unparsed` when any part of the command is outside what this lexer understands.
 */
export function analyzeBashCommand(command: string): BashCommandAnalysis {
	steps = 0;
	if (command.length > MAX_COMMAND_LENGTH) return { kind: "unparsed" };
	try {
		const out: string[][] = [];
		for (const segment of lexSegments(command)) expandSimpleCommand(segment, out);
		return { kind: "parsed", segments: out };
	} catch {
		// Fail closed: a parse failure, the depth or step budget, or a runtime error (a deep stack)
		// all mean `unparsed`, which no command-specific rule can allow.
		return { kind: "unparsed" };
	}
}

/** Lexer steps the last `analyzeBashCommand` call used (for scaling tests). */
export function lastAnalysisSteps(): number {
	return steps;
}

/**
 * Candidate command names for a command the lexer could not parse, used only so a deny rule still
 * matches: every plain word, at every position, read as the start of a command.
 */
export function bestEffortCommandLines(command: string): string[][] {
	const words = command
		.split(/[\s;&|()<>`$'"{}\\]+/)
		.filter((word) => /^[A-Za-z0-9._+/-]+$/.test(word))
		.map(pathBasename)
		.filter((word) => word !== "");
	return words.map((_word, index) => words.slice(index, index + CANDIDATE_WORDS));
}
