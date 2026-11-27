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
// sshpass's own options come before the command it runs (`sshpass -e ssh -p 2222 host`): its `-p` rule must not reach past
// them into that command.
const SSHPASS_OPTIONS = String.raw`(?:${SEP}(?:-[ev]|-[fdP](?:${SEP})?[^\s-][^\s]*))*`;

const FLAG_VALUE = new RegExp(
	String.raw`(?<![\w-])(--[A-Za-z][A-Za-z0-9_-]{0,63})(=(?:[ \t]*\\\r?\n[ \t]*)*|${SEP})(?!-)${VALUE}`,
	"g",
);
const FROM_ELSEWHERE = /-(?:stdin|file|path|env|prompt|command|cmd)$/i;
// For these clients a bare `--password` only asks for a prompt; the word after it is the database (`psql --password mydb`).
const PROMPTING_PASSWORD_CLIENT = /\b(?:psql|mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b/;

function promptsForPassword(text: string, offset: number, flag: string, separator: string): boolean {
	if (separator === "=" || flag.toLowerCase() !== "--password") return false;
	const before = text.slice(0, offset);
	const commandStart = Math.max(
		before.lastIndexOf(";"),
		before.lastIndexOf("&&"),
		before.lastIndexOf("||"),
		before.lastIndexOf("|"),
		before.lastIndexOf("\n"),
	);
	return PROMPTING_PASSWORD_CLIENT.test(before.slice(commandStart + 1));
}
const CLIENT_FLAG = new RegExp(
	String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b${SAME_COMMAND}${SEP}-p(?:\\\r?\n)?|\bsshpass\b${SSHPASS_OPTIONS}${SEP}-p(?:${SEP})?|\bredis-cli\b${SAME_COMMAND}${SEP}-a${SEP}|\bdocker\b${SAME_COMMAND}${SEP}login\b${SAME_COMMAND}${SEP}-p${SEP})(?!assword)${VALUE}`,
	"g",
);
/** `curl -u user:pw`, `--user=user:pw`, `-uuser:pw`, quoted or not: only the password half goes, a quoted one whole. */
const CURL_USER = new RegExp(
	String.raw`(\bcurl\b${SAME_COMMAND}${SEP}(?:-[A-Za-z]*u|--user(?![\w-]))(?:=|${SEP})?)(?:(?<q>\\?["'])([^:\n"'\\]*:)((?:(?!\k<q>)[^\n])*)\k<q>|([^\s:"'\\]*:)(<redacted>|[^\s"'<\\][^\s"'\\]*))`,
	"g",
);
const SECRET_ENV =
	/\b((?:PGPASSWORD|MYSQL_PWD|REDISCLI_AUTH|SSHPASS)[ \t]*=[ \t]*)(?:(["'])((?:(?!\2)[^\n])*)\2|(<redacted>|[^\s"'<][^\s"']*))/g;
const PROSE_SECRET = new RegExp(
	String.raw`\b((?:password|passphrase|passwd|secret|token)[ \t]+(?:is|was)(?:[ \t]*:[ \t]*|[ \t]+))${VALUE}([ \t]+[A-Za-z]+)?`,
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
			(
				match,
				flag: string,
				separator: string,
				quote: string | undefined,
				quoted: string,
				bare: string,
				offset: number,
				whole: string,
			) => {
				const name = flag.slice(2);
				if (!isSensitiveKeyName(name) || FROM_ELSEWHERE.test(name)) return match;
				if (promptsForPassword(whole, offset, flag, separator)) return match;
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

type ArgvClient = "mysql" | "sshpass" | "redis" | "docker-login" | "curl" | undefined;

function argvClient(items: readonly unknown[], index: number): ArgvClient {
	const words = items.slice(0, index).filter((item): item is string => typeof item === "string");
	const programs = words.map((word) => word.replace(/^.*[\\/]/, ""));
	if (programs.some((word) => /^(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)$/.test(word))) return "mysql";
	if (programs.includes("redis-cli")) return "redis";
	if (programs.includes("curl")) return "curl";
	if (programs.includes("docker") && words.includes("login")) return "docker-login";
	const at = programs.indexOf("sshpass");
	// Only sshpass's own options, before the command it runs, belong to it.
	if (
		at >= 0 &&
		words.slice(at + 1).every((word, i, rest) => word.startsWith("-") || /^-[fdP]$/.test(rest[i - 1] ?? ""))
	)
		return "sshpass";
	return undefined;
}

/** The value a client takes after (or glued to) a short flag, or undefined when `item` is not one. */
function clientSecret(client: ArgvClient, previous: unknown, item: string): string | undefined {
	const after = (flag: RegExp): boolean => typeof previous === "string" && flag.test(previous);
	switch (client) {
		case "mysql":
			return /^-p(?!assword)./.test(item) ? "-p<redacted>" : undefined;
		case "sshpass":
			if (/^-p./.test(item)) return "-p<redacted>";
			return after(/^-p$/) ? "<redacted>" : undefined;
		case "redis":
			return after(/^-a$/) ? "<redacted>" : undefined;
		case "docker-login":
			return after(/^-p$/) ? "<redacted>" : undefined;
		case "curl": {
			const glued = /^(-[A-Za-z]*u|--user=)([^:]*:)(.+)$/.exec(item);
			if (glued !== null) return `${glued[1]}${glued[2]}<redacted>`;
			const pair = /^([^:\s]*:)(.+)$/.exec(item);
			return pair !== null && after(/^(?:-[A-Za-z]*u|--user)$/) ? `${pair[1]}<redacted>` : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * An argument list (`["--api-key", "x"]`, `["mysql", "-ppw"]`, `["sshpass", "-p", "pw", "ssh", "host"]`): the item after a
 * sensitive long flag (with no `=` value of its own), and a known client's password flag value, as the string rules
 * treat the same command written out.
 */
export function redactFlagArguments(items: unknown[], onRedact: () => void): unknown[] {
	return items.map((item, index) => {
		const previous = items[index - 1];
		if (typeof item !== "string" || item.length === 0 || placeholder(item) || item.endsWith("<redacted>"))
			return item;
		const client = clientSecret(argvClient(items, index), previous, item);
		if (client !== undefined) {
			onRedact();
			return client;
		}
		if (item.startsWith("-")) return item;
		if (typeof previous !== "string" || !/^--[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(previous)) return item;
		const name = previous.slice(2);
		if (!isSensitiveKeyName(name) || FROM_ELSEWHERE.test(name)) return item;
		const words = items.slice(0, index).filter((word): word is string => typeof word === "string");
		if (
			name.toLowerCase() === "password" &&
			PROMPTING_PASSWORD_CLIENT.test(words.map((word) => word.replace(/^.*\//, "")).join(" "))
		)
			return item;
		onRedact();
		return "<redacted>";
	});
}
