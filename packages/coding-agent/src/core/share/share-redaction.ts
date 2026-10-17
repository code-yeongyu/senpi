import { homedir, hostname, userInfo } from "node:os";

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
	`(?:[A-Za-z]:)?${ANY_SEPARATOR}(?:Users|home)${ANY_SEPARATOR}(?!<user>)[^\\s/\\\\'"%:)<>\\]]{1,64}`,
	"gi",
);

function literalPattern(value: string): RegExp | undefined {
	const trimmed = value.trim();
	if (trimmed.length < MIN_LITERAL_LENGTH || COMMON_NAMES.has(trimmed.toLowerCase())) return undefined;
	return new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(trimmed)}(?!${WORD_CHAR})`, "giu");
}

const PRIVATE_KEY_BLOCK =
	/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g;

/** Credential shapes, each rewritten to a placeholder that no rule matches again. */
const CREDENTIAL_REWRITES: ReadonlyArray<readonly [RegExp, (match: string, ...groups: string[]) => string]> = [
	[
		/\b((?:Proxy-)?Authorization["']?\s{0,3}[:=]\s{0,3}(?:\[\s{0,3})?["']?(?:(?:Bearer|Basic|Token|Digest)\s{1,5})?)(?!<redacted>)[^\s"'\\]{4,}/gi,
		(_m, prefix) => `${prefix}<redacted>`,
	],
	// A bare scheme word is prose unless the value looks like a credential (has a digit or symbol).
	[
		/\b(Bearer|Basic|Token)(\s{1,5})(?!<redacted>)(?=[A-Za-z]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi,
		(_m, scheme, gap) => `${scheme}${gap}<redacted>`,
	],
	[
		/\b([A-Za-z][A-Za-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,64}:)(?!<redacted>@)[^\s/@]{1,256}@/g,
		(_m, prefix) => `${prefix}<redacted>@`,
	],
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
	[
		/(?<![A-Za-z0-9-])((?:Set-)?Cookie)(\s{0,3}:\s{0,3})(?!<redacted>)[^\n"]+/gi,
		(_m, name, sep) => `${name}${sep}<redacted>`,
	],
];

/** A key is sensitive when a sensitive word appears anywhere in it (`OPENAI_API_KEY`, `accessToken`). */
export const SENSITIVE_KEY =
	/token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|authorization|credential|private[_-]?key|session[_-]?id|cookie|signature/i;
const KEY_VALUE =
	/([A-Za-z0-9_.-]{1,128})((?:\\?["'])?\s{0,3}[:=]\s{0,3}(?:\\?["'])?)([^\s"'\\&,;}[{(][^\s"'\\&,;}]{0,1999})/g;
const SCHEME_WORD = /^(?:Bearer|Basic|Token)$/i;
/** An UPPER_SNAKE name with a credential segment (`DEEPSEEK_KEY`, `ANTHROPIC_AUTH`, `DB_PASS`), as in an env dump. */
const ENV_CREDENTIAL =
	/\b((?:[A-Z0-9]+_)*(?:KEY|KEYS|AUTH|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)(?:_[A-Z0-9]+)*)(\s{0,3}[=:]\s{0,3}["']?)(?!<redacted)([^\s"']{4,2000})/g;
/** A long base62 run with mixed case and digits is a generated secret; lowercase hex (commit ids, hashes) is not matched. */
const HIGH_ENTROPY_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

function shannonBitsPerChar(text: string): number {
	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
	return bits;
}

function looksGenerated(run: string): boolean {
	const digits = run.replace(/[^0-9]/g, "").length;
	const upper = run.replace(/[^A-Z]/g, "").length;
	const lower = run.replace(/[^a-z]/g, "").length;
	return digits >= 2 && upper >= 2 && lower >= 2 && shannonBitsPerChar(run) >= 4;
}

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}(?:@|%40)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}/g;
const IPV4 = /(?<!\d|\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g;

function keepsAddress(address: string): boolean {
	return address.startsWith("127.") || address === "0.0.0.0";
}

export function count(tally: ShareRedactionTally, category: ShareRedactionCategory): void {
	tally.set(category, (tally.get(category) ?? 0) + 1);
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
	for (const [pattern, rewrite] of CREDENTIAL_REWRITES) {
		result = result.replace(pattern, (...args: unknown[]) => {
			count(tally, "credential");
			const groups = args.slice(1).filter((value): value is string => typeof value === "string");
			return rewrite(String(args[0]), ...groups);
		});
	}
	result = result.replace(KEY_VALUE, (match, key: string, separator: string, value: string) => {
		if (!SENSITIVE_KEY.test(key) || value.startsWith("<redacted") || SCHEME_WORD.test(value)) return match;
		count(tally, "credential");
		return `${key}${separator}<redacted>`;
	});
	result = result.replace(ENV_CREDENTIAL, (_match, name: string, separator: string) => {
		count(tally, "credential");
		return `${name}${separator}<redacted>`;
	});
	result = result.replace(HIGH_ENTROPY_RUN, (run) => {
		if (!looksGenerated(run)) return run;
		count(tally, "credential");
		return "<redacted>";
	});

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
	] as const) {
		const pattern = literalPattern(value);
		if (!pattern) continue;
		result = result.replace(pattern, () => {
			count(tally, category);
			return placeholder;
		});
	}
	return result;
}
