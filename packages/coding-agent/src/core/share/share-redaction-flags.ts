import { isSensitiveKeyName } from "./share-sensitive-key.ts";

/**
 * Secrets that ride on a command line or in prose, where there is no `key: value` shape (senpi#3577). Tool-call arguments
 * are uploaded by /share by default, so these are the forms most likely to carry a real secret.
 *
 * - A long flag whose name is sensitive by the same key-name rule (`--password x`, `--api-key x`, `--token=x`) loses
 *   its value, quoted or not, also when the value is continued on the next line (`--password \\` newline `x`). A flag
 *   that names where the secret comes from (`--password-stdin`, `--token-file`) takes no value. `--max-tokens 4096`
 *   stays, as `max_tokens` is an ordinary name.
 * - Clients whose password is a short flag, also across line continuations: `mysql -p<pw>` (glued, quoted or not), `sshpass -p pw`,
 *   `redis-cli -a pw`, and the password half of `curl -u user:pw`. A rule stays inside its own command: it never runs
 *   past `;`, `&&`, `||` or `|` (`mysql db && tar -pxf a.tar` keeps `-pxf`).
 * - Environment names that hold a password but read as one word (`PGPASSWORD=pw`, `MYSQL_PWD=pw`).
 * - Prose that states a password, passphrase, secret or token (`my password is hunter2x`, `the token is 'a b'`), when the
 *   value looks like a secret (`proseLooksSecret`).
 *
 * Every rule leaves an existing `<redacted>` alone, so a second pass changes and counts nothing.
 */
// A quote may arrive JSON-escaped (`\"`), as the key/value rule also allows; a bare value never starts at a backslash. An
// existing placeholder is matched as a value too, so a rule consumes it (changing and counting nothing) instead of skipping
// ahead to a later flag.
const VALUE = String.raw`(?:(?<q>\\?["'])((?:(?!\k<q>)[^\n])*)\k<q>|(<redacted>|[^\s"'<\\][^\s"'\\]*))`;
// A line continuation (`\` then a newline) is part of the command, as the shell reads it.
const SEP = String.raw`(?:[ \t]|\\\r?\n)+`;
const SAME_COMMAND = String.raw`(?:(?!&&|\|\||[;|])(?:\\\r?\n|[^\n]))*?`;

const FLAG_VALUE = new RegExp(
	String.raw`(?<![\w-])(--[A-Za-z][A-Za-z0-9_-]{0,63})(=|[ \t]*\\\r?\n[ \t]*|[ \t]+)(?!-)${VALUE}`,
	"g",
);
const FROM_ELSEWHERE = /-(?:stdin|file|path|env|prompt|command|cmd)$/i;
const CLIENT_FLAG = new RegExp(
	String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b${SAME_COMMAND}${SEP}-p|\bsshpass\b${SAME_COMMAND}${SEP}-p(?:${SEP})?|\bredis-cli\b${SAME_COMMAND}${SEP}-a${SEP})(?!assword)${VALUE}`,
	"g",
);
/** `curl -u user:pw`, `--user=user:pw`, `-uuser:pw`, quoted or not: only the password half goes, a quoted one whole. */
const CURL_USER = new RegExp(
	String.raw`(\bcurl\b${SAME_COMMAND}${SEP}(?:-u|--user)(?:=|${SEP})?)(?:(?<q>\\?["'])([^:\n"'\\]*:)((?:(?!\k<q>)[^\n])*)\k<q>|([^\s:"'\\]*:)(<redacted>|[^\s"'<\\][^\s"'\\]*))`,
	"g",
);
const SECRET_ENV =
	/\b((?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|SSHPASS)[ \t]*=[ \t]*)(?:(["'])((?:(?!\2)[^\n])*)\2|(<redacted>|[^\s"'<][^\s"']*))/g;
const PROSE_SECRET = new RegExp(
	String.raw`\b((?:password|passphrase|passwd|secret|token)[ \t]+(?:is|was)[ \t]+)${VALUE}([ \t]+[A-Za-z]+)?`,
	"gi",
);
const LENGTH_UNIT = /^[ \t]+(?:characters?|chars?|letters?|digits?|bytes?|long)$/i;

/**
 * A bare value in prose is redacted only when it looks like a secret: a digit or a symbol in it (`hunter2x`, `p@ss`).
 * A word, even a long or hyphenated one (`generated`, `short-lived`, `per-request`), reads as the sentence going on and
 * stays: a letters-only password said in prose cannot be told from prose. A quoted value is always redacted.
 */
function proseLooksSecret(value: string, next: string): boolean {
	if (/^\d+$/.test(value) && LENGTH_UNIT.test(next)) return false;
	return !/^[A-Za-z]+(?:-[A-Za-z]+)*$/.test(value);
}

const placeholder = (value: string): boolean => value === "<redacted>";

export function redactFlagSecrets(text: string, onRedact: () => void): string {
	const redactValue = (prefix: string, quote: string | undefined, value: string): string => {
		if (placeholder(value)) return `${prefix}${quote ?? ""}${value}${quote ?? ""}`;
		onRedact();
		return quote === undefined ? `${prefix}<redacted>` : `${prefix}${quote}<redacted>${quote}`;
	};
	return text
		.replace(
			FLAG_VALUE,
			(match, flag: string, separator: string, quote: string | undefined, quoted: string, bare: string) => {
				const name = flag.slice(2);
				if (!isSensitiveKeyName(name) || FROM_ELSEWHERE.test(name)) return match;
				return redactValue(`${flag}${separator}`, quote, quote === undefined ? bare : quoted);
			},
		)
		.replace(CLIENT_FLAG, (_match, prefix: string, quote: string | undefined, quoted: string, bare: string) =>
			redactValue(prefix, quote, quote === undefined ? bare : quoted),
		)
		.replace(
			CURL_USER,
			(
				_match,
				prefix: string,
				quote: string | undefined,
				quotedUser: string,
				quotedPassword: string,
				user: string,
				password: string,
			) =>
				quote === undefined
					? redactValue(`${prefix}${user}`, undefined, password)
					: `${prefix}${quote}${quotedUser}${redactValue("", undefined, quotedPassword)}${quote}`,
		)
		.replace(SECRET_ENV, (_match, prefix: string, quote: string | undefined, quoted: string, bare: string) =>
			redactValue(prefix, quote, quote === undefined ? bare : quoted),
		)
		.replace(
			PROSE_SECRET,
			(match, lead: string, quote: string | undefined, quoted: string, bare: string, next = "") => {
				const value = quote === undefined ? bare : quoted;
				if (quote === undefined && !proseLooksSecret(value, next)) return match;
				return redactValue(lead, quote, value) + next;
			},
		);
}

/** `["--api-key", "<value>"]`: the item after a sensitive long flag (with no `=` value of its own) is its value. */
export function redactFlagArguments(items: unknown[], onRedact: () => void): unknown[] {
	return items.map((item, index) => {
		const previous = items[index - 1];
		if (typeof item !== "string" || item.length === 0 || item.startsWith("-") || placeholder(item)) return item;
		if (typeof previous !== "string" || !/^--[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(previous)) return item;
		const name = previous.slice(2);
		if (!isSensitiveKeyName(name) || FROM_ELSEWHERE.test(name)) return item;
		onRedact();
		return "<redacted>";
	});
}
