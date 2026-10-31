import { homedir, hostname, userInfo } from "node:os";
import { redactGeneratedValues } from "./share-entropy.ts";
import { isSensitiveKeyName } from "./share-sensitive-key.ts";

/**
 * Redaction for content that leaves the machine (`/share`, #3524).
 *
 * Same two-stage order as the desktop problem-report redactor: identity first
 * (the real home directory, the account name and the host name, in every
 * spelling a path takes inside JSON, URLs and Windows text), then generic
 * shapes (credentials, private keys, emails, addresses). Every replacement is
 * counted from its own callback, so the preview can say what was removed
 * without inferring it from placeholder deltas. The rewrite is idempotent:
 * running it on its own output changes nothing and counts nothing.
 */
export interface ShareRedactionContext {
	readonly homeDirectory: string;
	readonly userName: string;
	readonly hostName: string;
	readonly extraLiterals?: readonly string[];
}

export type ShareRedactionCategory =
	| "home path"
	| "user name"
	| "host name"
	| "private key"
	| "credential"
	| "email"
	| "ip address"
	| "image";

export type ShareRedactionTally = Map<ShareRedactionCategory, number>;

export function currentShareRedactionContext(): ShareRedactionContext {
	let userName = "";
	try {
		userName = userInfo().username;
	} catch {
		userName = process.env.USER ?? process.env.USERNAME ?? "";
	}
	return { homeDirectory: homedir(), userName, hostName: hostname() };
}

const MIN_LITERAL_LENGTH = 3;
const IDENTITY_CHAR = "[\\p{L}\\p{N}\\p{M}_.-]";
const WORD_CHAR = "[\\p{L}\\p{N}\\p{M}]";
/** Account names too generic to scrub as words without garbling ordinary text. */
const COMMON_NAMES = new Set([
	"admin",
	"user",
	"users",
	"test",
	"home",
	"root",
	"runner",
	"guest",
	"default",
	"shared",
]);

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every spelling a separator takes in exported text: `/`, `\`, JSON `\\`, `%2F`/`%5C`. */
const ANY_SEPARATOR = "(?:/|\\\\{1,2}|%2[Ff]|%5[Cc])";

function homePattern(homeDirectory: string): RegExp | undefined {
	const segments = homeDirectory.split(/[\\/]+/).filter((segment) => segment.length > 0);
	if (segments.length === 0) return undefined;
	const drive = /^[A-Za-z]:$/.test(segments[0] ?? "") ? segments.shift() : undefined;
	const body = segments.map((segment) => escapeRegExp(segment).replace(/ /g, "(?: |%20|\\+)")).join(ANY_SEPARATOR);
	const prefix = drive === undefined ? ANY_SEPARATOR : `${escapeRegExp(drive)}${ANY_SEPARATOR}`;
	return new RegExp(`(?:file:${ANY_SEPARATOR}{0,3})?${prefix}${body}(?!${IDENTITY_CHAR})`, "giu");
}

/** Generic home folders of other accounts (`/Users/x`, `/home/x`, `C:\Users\x`). */
const OTHER_HOME = new RegExp(
	`(?:[A-Za-z]:)?${ANY_SEPARATOR}(?:Users|home)${ANY_SEPARATOR}[^\\s/\\\\'"%:)<>\\]]{1,64}`,
	"gi",
);

function literalPattern(value: string): RegExp | undefined {
	const trimmed = value.trim();
	if (trimmed.length < MIN_LITERAL_LENGTH || COMMON_NAMES.has(trimmed.toLowerCase())) return undefined;
	return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(trimmed)}(?!${WORD_CHAR})`, "giu");
}

const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g;

/** Credential shapes, each rewritten to a placeholder that no rule matches again. */
const CREDENTIAL_REWRITES: ReadonlyArray<readonly [RegExp, (match: string, ...groups: string[]) => string]> = [
	// A bare scheme word is prose unless the value looks like a credential (has a digit or symbol). A value that starts
	// with an earlier placeholder is still a value: the placeholder is replaced along with it.
	[
		/\b(Bearer|Basic|Token)(\s{1,5})(?:<redacted>)?(?=[A-Za-z]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi,
		(_m, scheme, gap) => `${scheme}${gap}<redacted>`,
	],
	[/\b([A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:)[^\s/@]{1,256}@/g, (_m, prefix) => `${prefix}<redacted>@`],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => "<redacted>"],
	[/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, () => "<redacted>"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => "<redacted>"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, () => "<redacted>"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => "<redacted>"],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => "<redacted>"],
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, () => "<redacted>"],
	[/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, () => "<redacted>"],
	[/\bhf_[A-Za-z0-9]{30,}/g, () => "<redacted>"],
	[/\bnpm_[A-Za-z0-9]{36}\b/g, () => "<redacted>"],
	[/\bglpat-[A-Za-z0-9_-]{20,}/g, () => "<redacted>"],
	[/(?<![A-Za-z0-9-])((?:Set-)?Cookie)(\s{0,3}:\s{0,3})[^\n"]+/gi, (_m, name, sep) => `${name}${sep}<redacted>`],
];

/**
 * `key: value` / `key=value` in text. A quoted value runs to its closing quote; an unquoted one to the end of the line or
 * the next `,;})`, so a value of several words is replaced whole.
 */
const KEY_VALUE =
	/([A-Za-z0-9_.[\]-]{1,128})((?:\\?["'])?[ \t]{0,3}[:=][ \t]{0,3})(?:(\\?["'])((?:(?!\3)[^\n]){0,2000})\3|([^\s"'\\&,;}[{(=)][^\n"'\\&,;}()]{0,1999}))/g;
/** A sensitive key whose value is an inline array or object: every quoted string inside it is a credential. */
const KEY_COLLECTION =
	/((["']?)([A-Za-z0-9_.-]{1,128})\2[ \t]{0,3}[:=][ \t]{0,3})(\[[^\]\n]{0,2000}\]|\{[^}\n]{0,2000}\})/g;
/** A YAML key followed by a block list (`tokens:` then `  - value` lines). */
const KEY_YAML_LIST = /^([ \t]*)([A-Za-z0-9_.-]{1,128}):[ \t]*\r?\n((?:\1[ \t]*-[ \t]+[^\n]*(?:\r?\n|$))+)/gm;
/** Counting only: a value that is nothing but a scheme word and placeholders was already counted by the rule that redacted it. */
const ALREADY_REDACTED = /^(?:(?:Bearer|Basic|Token|Digest)\s+)?(?:<redacted>\s*)+$/i;
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g;
const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}(?:@|%40)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g;
const IPV4 = /(?<!\d|\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g;

function keepsAddress(address: string): boolean {
	return address.startsWith("127.") || address === "0.0.0.0";
}

export function count(tally: ShareRedactionTally, category: ShareRedactionCategory): void {
	tally.set(category, (tally.get(category) ?? 0) + 1);
}

function redactQuoted(quoted: string, tally: ShareRedactionTally): string {
	const quote = quoted[0] ?? '"';
	if (quoted.length <= 2) return quoted;
	const replaced = `${quote}<redacted>${quote}`;
	if (replaced !== quoted) count(tally, "credential");
	return replaced;
}

// Placeholders this redactor writes. The literal pass runs last, so it must not rewrite a placeholder an earlier pass
// produced (an identity literal such as "redacted" or "email" would otherwise turn "<redacted>" into "<<user>>").
const PLACEHOLDER = /<(?:redacted(?: private key)?|email|ip|host|user)>|\[image omitted from share\]/g;

function replaceOutsidePlaceholders(text: string, pattern: RegExp, replace: () => string): string {
	let out = "";
	let last = 0;
	for (const match of text.matchAll(PLACEHOLDER)) {
		const at = match.index ?? 0;
		out += text.slice(last, at).replace(pattern, replace) + match[0];
		last = at + match[0].length;
	}
	return out + text.slice(last).replace(pattern, replace);
}

export function redactShareText(text: string, context: ShareRedactionContext, tally: ShareRedactionTally): string {
	if (text.length === 0) return text;
	let result = text;

	const home = homePattern(context.homeDirectory);
	if (home) {
		result = result.replace(home, () => {
			count(tally, "home path");
			return "~";
		});
	}
	result = result.replace(OTHER_HOME, (match) => {
		count(tally, "home path");
		return match.replace(/[^/\\%]+$/, "<user>");
	});

	result = result.replace(DATA_URI, () => {
		count(tally, "image");
		return "[image omitted from share]";
	});
	result = result.replace(PRIVATE_KEY_BLOCK, () => {
		count(tally, "private key");
		return "<redacted private key>";
	});
	result = result.replace(KEY_COLLECTION, (match, prefix: string, _quote: string, key: string, collection: string) => {
		if (!isSensitiveKeyName(key)) return match;
		return prefix + collection.replace(QUOTED, (quoted) => redactQuoted(quoted, tally));
	});
	result = result.replace(KEY_YAML_LIST, (match, indent: string, key: string, items: string) => {
		if (!isSensitiveKeyName(key)) return match;
		const redacted = items.replace(/^([ \t]*-[ \t]+)(\S[^\n]*)/gm, (_item, bullet: string, item: string) => {
			if (item !== "<redacted>") count(tally, "credential");
			return `${bullet}<redacted>`;
		});
		return `${indent}${key}:\n${redacted}`;
	});
	for (const [pattern, rewrite] of CREDENTIAL_REWRITES) {
		result = result.replace(pattern, (...args: unknown[]) => {
			const match = String(args[0]);
			const groups = args.slice(1).filter((value): value is string => typeof value === "string");
			const replaced = rewrite(match, ...groups);
			if (replaced !== match) count(tally, "credential");
			return replaced;
		});
	}
	result = result.replace(
		KEY_VALUE,
		(match, key: string, separator: string, quote: string | undefined, quoted: string, bare: string | undefined) => {
			if (!isSensitiveKeyName(key) || (quote === undefined && bare === "<redacted>")) return match;
			const replaced =
				quote === undefined
					? `${key}${separator}<redacted>${(bare ?? "").match(/\s*$/)?.[0] ?? ""}`
					: `${key}${separator}${quote}<redacted>${quote}`;
			const value = quote === undefined ? (bare ?? "") : quoted;
			if (replaced !== match && !ALREADY_REDACTED.test(value.trim())) count(tally, "credential");
			return replaced;
		},
	);
	result = redactGeneratedValues(result, () => count(tally, "credential"));

	result = result.replace(EMAIL, () => {
		count(tally, "email");
		return "<email>";
	});
	result = result.replace(IPV4, (address) => {
		if (keepsAddress(address)) return address;
		count(tally, "ip address");
		return "<ip>";
	});

	const shortHost = context.hostName.split(".")[0] ?? "";
	for (const [value, placeholder, category] of [
		[context.hostName, "<host>", "host name"],
		[shortHost, "<host>", "host name"],
		[context.userName, "<user>", "user name"],
		...(context.extraLiterals ?? []).map((value) => [value, "<user>", "user name"] as const),
	] as const) {
		const pattern = literalPattern(value);
		if (!pattern) continue;
		result = replaceOutsidePlaceholders(result, pattern, () => {
			count(tally, category);
			return placeholder;
		});
	}
	return result;
}
