/**
 * The wider "Allow always" a prompt may offer for a tool WITHOUT its own permission parser, where
 * plain "Allow always" remembers only the exact argument (one URL, one input) and so asks again for
 * the next one (senpi#3403):
 * - a URL argument: that URL's DOMAIN (scheme + canonical host + non-default port), stored as one
 *   literal and matched by equality, never the whole tool: a tool-wide allow for a browser or
 *   fetch tool would mean "go anywhere", close to Full access for the web;
 * - a free `input`/`pattern` argument: the tool itself, for this project;
 * - a command or a path: nothing wider (that would grant a shell or file access wholesale).
 * Built-in tools (bash, eval, edit, write, read, ...) have parsers and never reach this.
 */
export interface WiderAlwaysScope {
	/** The option label, stating the scope in plain words. */
	readonly label: string;
	/** The patterns an answer with this option approves for the permission. */
	readonly patterns: string[];
}

/** Never widened, even if a future change routes one of them through the fallback. */
const NEVER_WIDENED = new Set([
	"bash",
	"eval",
	"edit",
	"write",
	"read",
	"apply_patch",
	"multiedit",
	"glob",
	"grep",
	"ls",
]);

/**
 * The only raw URL shape that gets a domain alias: `http(s)://`, an ASCII DNS host (letters, digits,
 * dots, dashes; no trailing dot), an optional port, then `/`, `?`, `#` or the end. No userinfo, no
 * percent-escape, no IPv6 brackets.
 */
const UNAMBIGUOUS_URL = /^(https?):\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::([0-9]{1,5}))?(?:[/?#]|$)/;
/** Characters that let one parser read another host than the next: backslash, `@`, `%`, whitespace, controls. */
const AMBIGUOUS_CHARACTER = /[\\@%\s\u0000-\u001f\u007f]/;
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

/**
 * The one normalizer both sides of a domain grant go through (senpi#3403). A parser-less tool (an
 * MCP server, a custom tool) parses the URL itself, and the permission layer cannot make it reuse
 * this parse. So a domain origin is given only for raw text every parser reads as the same host:
 * the strict shape above, no ambiguous character anywhere, and the same host and port as the WHATWG
 * parser finds (#3416 review: `https://example.invalid\\@evil.test/` is example.invalid to WHATWG and
 * evil.test to curl and Python). Anything else gets no alias and no domain option, so it asks.
 */
export function canonicalUrlOrigin(raw: string): string | undefined {
	if (AMBIGUOUS_CHARACTER.test(raw)) return undefined;
	const match = UNAMBIGUOUS_URL.exec(raw);
	if (match === null) return undefined;
	const scheme = match[1].toLowerCase();
	const host = match[2].toLowerCase();
	const port = match[3] === undefined || match[3] === DEFAULT_PORTS[scheme] ? "" : String(Number(match[3]));
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== `${scheme}:` || url.hostname !== host || url.port !== port) return undefined;
	return `${scheme}://${host}${port === "" ? "" : `:${port}`}`;
}

/**
 * The match target a domain grant is written for: a literal that never contains a wildcard
 * character, so the grant matches by equality. The `origin=` prefix keeps it from colliding with a
 * user's own URL rules.
 */
export function urlOriginAlias(raw: string): string | undefined {
	const origin = canonicalUrlOrigin(raw);
	return origin === undefined ? undefined : `origin=${origin}`;
}

export function widerAlwaysScope(toolName: string, argKey: string, arg: string): WiderAlwaysScope | undefined {
	if (NEVER_WIDENED.has(toolName)) return undefined;
	if (argKey === "url") {
		const origin = canonicalUrlOrigin(arg);
		if (origin === undefined) return undefined;
		return {
			label: `Allow ${toolName} on ${origin.slice(origin.indexOf("//") + 2)} always in this project`,
			patterns: [`origin=${origin}`],
		};
	}
	if (argKey === "input" || argKey === "pattern") {
		return { label: `Allow ${toolName} always in this project`, patterns: ["*"] };
	}
	return undefined;
}
