import { isSensitiveKeyName } from "./share-sensitive-key.ts";

/**
 * Secrets that ride on a command line or in prose, where there is no `key: value` shape (senpi#3577). Tool-call arguments
 * are uploaded by /share by default, so these are the forms most likely to carry a real secret.
 *
 * - A long flag whose name is sensitive by the same key-name rule (`--password x`, `--api-key x`, `--token=x`) loses
 *   its value; `--max-tokens 4096` stays, as `max_tokens` is an ordinary name.
 * - `-p<password>` glued to the flag only after a MySQL client: `-p` alone is a path or a flag everywhere else
 *   (`mkdir -p`).
 * - Prose that states a password, passphrase or secret (`my password is x`).
 */
const FLAG_VALUE =
	/(?<![\w-])(--[A-Za-z][A-Za-z0-9_-]{0,63})(=|[ \t]+)(?:(["'])((?:(?!\3)[^\n])+)\3|(?!-)([^\s"'<][^\s"']*))/g;
const MYSQL_PASSWORD = /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]*?[ \t]-p)(?!assword)([^\s"'<-][^\s"']*)/g;
const PROSE_SECRET =
	/\b((?:password|passphrase|passwd|secret)[ \t]+(?:is|was)[ \t]+)(["']?)(?![A-Za-z]+\b(?![^\s]))([^\s"'<]+)\2/gi;

export function redactFlagSecrets(text: string, onRedact: () => void): string {
	return text
		.replace(FLAG_VALUE, (match, flag: string, separator: string, quote: string | undefined) => {
			if (!isSensitiveKeyName(flag.slice(2))) return match;
			onRedact();
			return quote === undefined ? `${flag}${separator}<redacted>` : `${flag}${separator}${quote}<redacted>${quote}`;
		})
		.replace(MYSQL_PASSWORD, (_match, prefix: string) => {
			onRedact();
			return `${prefix}<redacted>`;
		})
		.replace(PROSE_SECRET, (_match, lead: string, quote: string) => {
			onRedact();
			return `${lead}${quote}<redacted>${quote}`;
		});
}

/** `["--api-key", "<value>"]`: the item after a sensitive long flag (with no `=` value of its own) is its value. */
export function redactFlagArguments(items: unknown[], onRedact: () => void): unknown[] {
	return items.map((item, index) => {
		const previous = items[index - 1];
		if (typeof item !== "string" || item.length === 0 || item.startsWith("-") || item === "<redacted>") return item;
		if (typeof previous !== "string" || !/^--[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(previous)) return item;
		if (!isSensitiveKeyName(previous.slice(2))) return item;
		onRedact();
		return "<redacted>";
	});
}
