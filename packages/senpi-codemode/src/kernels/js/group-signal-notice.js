// senpi#2995: Bun.$, node:child_process exec/execFile and the synchronous spawners leave their children in the
// agent's process group (Bun.$ has no such option, Bun ignores `detached` for exec/execFile, and a synchronous call
// keeps the terminal), so a group-wide signal from the same cell stops the agent. Such a command gets a notice; the
// notice only warns and never fails the cell.

// A command starts a (possibly indented) line, follows `;`, `|`, `&`, `(`, a backtick, `{`, `!`, a shell keyword
// (`then`, `do`, `else`) or a runner (`nohup`, `time`, `xargs`, `env`, `exec`, `sudo` with flags), or opens a `-c '...'` script; a
// `kill` word anywhere else (`git log --grep kill`, `echo kill ...`) is text.
const COMMAND_POSITION = String.raw`(?:^\s*|[;|&(\x60]\s*|\b(?:then|do|else|nohup|time|xargs|env|exec)\s+|[{!]\s+|\bsudo(?:\s+-\S+)*\s+|\s-[A-Za-z]*c\s+['"]\s*)`;

// A group target is a dash argument after the signal options: a number, `$var`, `${var}` or `$(...)`.
const GROUP_TARGET = String.raw`-(?:\d+|\$\$|\$\{?\w+\}?|\$\()`;
const SIGNAL_OPTION = String.raw`(?:-s\s+\w+|-n\s+\d+|-[A-Za-z]+\d*|-\d+)`;
// The first dash argument is a signal, so a group is one after `--`, after a signal option, or after a plain pid:
// `kill -- -<pgid>`, `kill -SIG -<pgid>`, `kill -TERM 1234 -5678`, `kill -- -$$`.
const PID = String.raw`[^\s\-;|&][^\s;|&]*`;
const KILL_GROUP = new RegExp(
	String.raw`${COMMAND_POSITION}kill\b(?:` +
		String.raw`\s+--\s+${GROUP_TARGET}` +
		String.raw`|(?:\s+${SIGNAL_OPTION})+(?:\s+${PID})*\s+(?:--\s+)?${GROUP_TARGET}` +
		String.raw`|(?:\s+${SIGNAL_OPTION})*(?:\s+${PID})+\s+${GROUP_TARGET})`,
	"mu",
);
const PKILL_GROUP = new RegExp(String.raw`${COMMAND_POSITION}pkill\b[^\n;|&]*\s(?:-g\d*|--pgroup)\b`, "mu");
// `killall` in command position (also after `sudo` or as a `-c` script) signals every process with that name, which
// can include the agent's own (bun, node, senpi). Inside an `echo` string it is only text.
const KILLALL = new RegExp(String.raw`${COMMAND_POSITION}killall\s`, "mu");

// senpi#3019: a keyword inside quoted text is not a command position, so the scan runs on a copy whose inert text is
// blanked: single-quoted strings, comments, and the literal parts of double-quoted strings and heredoc bodies (all of a
// body whose delimiter is quoted). A command substitution, `$(...)` or a backtick pair, runs even inside double quotes
// and unquoted heredoc bodies, so it keeps its text, as a `-c` script does; both are command lines, with their own inert
// text blanked in turn. A `<<` whose delimiter line never comes blanks nothing.
const SCRIPT_FLAG_BEFORE_QUOTE = /(?:^|\s)-[A-Za-z]*c\s+$/u;
const WORD_END = /[\s;&|<>()]/u;
const BEFORE_COMMENT = /[\s;&|()]/u;

function blank(text) {
	return text.replace(/[^\n]/gu, "x");
}

// For a `$(` or a backtick at `index`: the index of the `)` or backtick that closes it, or -1 when none does. Anything
// else: undefined.
function substitutionEnd(text, index) {
	if (text[index] === "`") return text.indexOf("`", index + 1);
	if (text[index] !== "$" || text[index + 1] !== "(") return undefined;
	let depth = 0;
	for (let at = index + 1; at < text.length; at++) {
		const char = text[at];
		if (char === "\\") {
			at++;
		} else if (char === "'" || char === '"') {
			at = closingQuote(text, at);
		} else if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth--;
			if (depth === 0) return at;
		}
	}
	return -1;
}

// The index of the quote that closes the one at `open`, or the text length. A substitution inside double quotes is a
// context of its own, so a quote inside it does not close the string.
function closingQuote(text, open) {
	const quote = text[open];
	for (let index = open + 1; index < text.length; index++) {
		if (text[index] === quote) return index;
		if (quote === "'") continue;
		const end = substitutionEnd(text, index);
		if (end === -1) return text.length;
		if (end !== undefined) index = end;
		else if (text[index] === "\\") index++;
	}
	return text.length;
}

function blankLiteralText(text) {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const end = substitutionEnd(text, index);
		if (end !== undefined && end !== -1) {
			const open = text[index] === "`" ? 1 : 2;
			out += text.slice(index, index + open) + blankQuotedText(text.slice(index + open, end)) + text[end];
			index = end + 1;
			continue;
		}
		const step = text[index] === "\\" ? 2 : 1;
		out += blank(text.slice(index, index + step));
		index += step;
	}
	return out;
}

// `<<` or `<<-`, optional blanks, then the delimiter word up to an unquoted blank or operator. Quote removal gives the
// delimiter, and any quoting in the word leaves the body unexpanded.
function readHeredoc(text, at) {
	let index = at + 2;
	const stripTabs = text[index] === "-";
	if (stripTabs) index++;
	while (text[index] === " " || text[index] === "\t") index++;
	let delimiter = "";
	let quoted = false;
	while (index < text.length && !WORD_END.test(text[index])) {
		const char = text[index];
		if (char === "'" || char === '"') {
			const end = text.indexOf(char, index + 1);
			if (end === -1) return undefined;
			delimiter += text.slice(index + 1, end);
			quoted = true;
			index = end + 1;
		} else if (char === "\\") {
			delimiter += text[index + 1] ?? "";
			quoted = true;
			index += 2;
		} else {
			delimiter += char;
			index++;
		}
	}
	return delimiter ? { delimiter, quoted, stripTabs, end: index } : undefined;
}

function closingLine(text, from, { delimiter, stripTabs }) {
	let start = from;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const line = text.slice(start, end);
		if ((stripTabs ? line.replace(/^\t+/u, "") : line) === delimiter) return { start, end };
		start = end + 1;
	}
	return undefined;
}

function blankQuotedText(text) {
	let out = "";
	const heredocs = [];
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			out += text.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (char === "'" || char === '"') {
			const end = closingQuote(text, index);
			const inner = text.slice(index + 1, end);
			if (SCRIPT_FLAG_BEFORE_QUOTE.test(out)) out += char + blankQuotedText(inner);
			else out += char + (char === "'" ? blank(inner) : blankLiteralText(inner));
			if (end < text.length) out += char;
			index = end + 1;
			continue;
		}
		if (char === "#" && (index === 0 || BEFORE_COMMENT.test(text[index - 1]))) {
			const newline = text.indexOf("\n", index);
			const end = newline === -1 ? text.length : newline;
			out += blank(text.slice(index, end));
			index = end;
			continue;
		}
		if (text.startsWith("<<<", index)) {
			out += "<<<";
			index += 3;
			continue;
		}
		const heredoc = text.startsWith("<<", index) ? readHeredoc(text, index) : undefined;
		if (heredoc) {
			heredocs.push(heredoc);
			out += text.slice(index, heredoc.end);
			index = heredoc.end;
			continue;
		}
		out += char;
		index++;
		if (char !== "\n") continue;
		// Each body starts on the line after its `<<` and ends at a line holding only its delimiter.
		for (const pending of heredocs.splice(0)) {
			const close = closingLine(text, index, pending);
			if (!close) break;
			const body = text.slice(index, close.start);
			out += (pending.quoted ? blank(body) : blankLiteralText(body)) + text.slice(close.start, close.end);
			index = close.end;
			if (text[index] === "\n") {
				out += "\n";
				index++;
			}
		}
	}
	return out;
}

export const GROUP_SIGNAL_NOTICE_TAG = "[senpi:group-signal]";

export function signalsProcessGroup(commandText) {
	const text = blankQuotedText(commandText);
	return KILL_GROUP.test(text) || PKILL_GROUP.test(text) || KILLALL.test(text);
}

export function groupSignalNotice(api, readGroup = agentProcessGroup) {
	const pgid = readGroup();
	const group = pgid === undefined ? "the agent's process group" : `the agent's process group (${pgid})`;
	return (
		`${GROUP_SIGNAL_NOTICE_TAG} This command signals a process group. Children of ${api} share ${group}, so ` +
		"signalling that group can stop this session. Start background jobs with Bun.spawn or child_process.spawn, " +
		"which give them their own group, or signal them by pid.\n"
	);
}

let cachedGroup;

// A bounded `ps` lookup, kept once it succeeds; a missing `ps` or a failed run only drops the number from this notice.
export function agentProcessGroup(spawnSync = globalThis.Bun?.spawnSync) {
	if (cachedGroup !== undefined) return cachedGroup;
	let text = "";
	try {
		const result = spawnSync?.(["ps", "-o", "pgid=", "-p", String(process.pid)], { timeout: 2_000 });
		text = result?.success ? String(result.stdout).trim() : "";
	} catch {
		text = "";
	}
	if (!/^\d+$/u.test(text)) return undefined;
	cachedGroup = text;
	return cachedGroup;
}

export function shellCommandText(strings, expressions) {
	if (!Array.isArray(strings)) return String(strings ?? "");
	return strings.reduce((text, part, index) => text + part + (index < expressions.length ? String(expressions[index]) : ""), "");
}

const { promisify } = process.getBuiltinModule("node:util");
const SCANNED_SPAWNERS = ["exec", "execFile", "execSync", "execFileSync", "spawnSync"];

function commandTextOf(name, args) {
	if (name === "exec" || name === "execSync") return String(args[0]);
	return [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].join(" ");
}

export function noticeChildProcessGroupSignals(emitText, isActive) {
	const childProcess = process.getBuiltinModule("node:child_process");
	const originals = new Map();
	for (const name of SCANNED_SPAWNERS) {
		const original = childProcess[name];
		if (typeof original !== "function") continue;
		originals.set(name, original);
		const scan = (args) => {
			try {
				if (isActive() && signalsProcessGroup(commandTextOf(name, args))) {
					emitText("stderr", groupSignalNotice(`child_process.${name}`));
				}
			} catch {
				// The notice is advisory; the call itself always runs.
			}
		};
		const scanned = function scannedSpawner(...args) {
			scan(args);
			return original.apply(this, args);
		};
		// Every own property, symbols included: `util.promisify.custom` is what makes promisify(exec) resolve to
		// { stdout, stderr }. That custom function calls the original directly, so it is scanned too.
		for (const key of Reflect.ownKeys(original)) {
			if (key === "length" || key === "name" || key === "prototype" || key === promisify.custom) continue;
			const descriptor = Object.getOwnPropertyDescriptor(original, key);
			if (descriptor) Object.defineProperty(scanned, key, descriptor);
		}
		const customPromisify = original[promisify.custom];
		if (typeof customPromisify === "function") {
			Object.defineProperty(scanned, promisify.custom, {
				configurable: true,
				value: function scannedPromisified(...args) {
					scan(args);
					return customPromisify.apply(this, args);
				},
			});
		}
		childProcess[name] = scanned;
	}
	return () => {
		for (const [name, original] of originals) childProcess[name] = original;
	};
}
