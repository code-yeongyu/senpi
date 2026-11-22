/**
 * `credentialProxy.credentials` (senpi#6820): which engine environment variables are credentials that agent-spawned
 * processes never receive, and the one upstream each may be used against through the loopback proxy. Read from the
 * user's global settings only: a project's settings could otherwise point a credential at a host of its choosing.
 */

export interface CredentialDeclaration {
	/** The engine environment variable holding the value; agent children get a placeholder instead. */
	readonly env: string;
	/** The only upstream the value is sent to: `https://host[:port][/base/path]` (plain `http` only for loopback). */
	readonly origin: string;
	/** The request header the proxy sets. Default `authorization`. */
	readonly header: string;
	/** Prefix written before the value, separated by one space (`Bearer`). Default: none for custom headers, `Bearer` for `authorization`. */
	readonly scheme: string | undefined;
	/** A child environment variable set to the proxy route, for clients that read a base URL (`OPENAI_BASE_URL`). */
	readonly baseUrlEnv: string | undefined;
	/** When given, only request paths (below `origin`'s path) starting with one of these are forwarded. */
	readonly pathPrefixes: readonly string[] | undefined;
}

export interface ParsedCredentialDeclarations {
	readonly credentials: readonly CredentialDeclaration[];
	/** Every `env` name found, valid entry or not: these are withheld from children even when an entry is rejected. */
	readonly withheldNames: readonly string[];
	readonly problems: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SCHEME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Headers the proxy owns or that describe the hop, never a credential header. */
const RESERVED_HEADERS = new Set([
	"connection",
	"content-length",
	"content-encoding",
	"host",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function parseOrigin(value: unknown): { origin: string } | { problem: string } {
	if (typeof value !== "string" || value.length === 0) return { problem: "origin must be a URL string" };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { problem: "origin is not a valid URL" };
	}
	if (url.username !== "" || url.password !== "") return { problem: "origin must not carry credentials" };
	if (url.search !== "" || url.hash !== "") return { problem: "origin must not have a query or fragment" };
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
		return { problem: "origin must use https (plain http only for a loopback host)" };
	return { origin: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

function parsePathPrefixes(value: unknown): { prefixes: readonly string[] | undefined } | { problem: string } {
	if (value === undefined) return { prefixes: undefined };
	if (!Array.isArray(value) || value.length === 0) return { problem: "pathPrefixes must be a non-empty array" };
	const prefixes: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !entry.startsWith("/") || hasUnsafePathSegment(entry))
			return { problem: "each pathPrefixes entry must be a plain absolute path" };
		prefixes.push(entry);
	}
	return { prefixes };
}

/** A path the proxy refuses: dot segments, encoded separators or dots, backslashes. */
export function hasUnsafePathSegment(path: string): boolean {
	if (/%2e|%2f|%5c|\\/i.test(path)) return true;
	// `..;x` and `.;x` normalise to `..`/`.` on servers that strip path parameters (Tomcat-style).
	return path.split("/").some((segment) => segment === "." || segment.startsWith("..") || segment.startsWith(".;"));
}

export function parseCredentialDeclarations(raw: unknown): ParsedCredentialDeclarations {
	if (raw === undefined) return { credentials: [], withheldNames: [], problems: [] };
	const list = typeof raw === "object" && raw !== null ? Reflect.get(raw, "credentials") : undefined;
	if (list === undefined) return { credentials: [], withheldNames: [], problems: [] };
	if (!Array.isArray(list))
		return { credentials: [], withheldNames: [], problems: ["credentialProxy.credentials must be an array"] };
	const credentials: CredentialDeclaration[] = [];
	const withheld = new Set<string>();
	const problems: string[] = [];
	const baseUrlNames = new Set<string>();
	list.forEach((entry: unknown, index) => {
		const at = `credentialProxy.credentials[${index}]`;
		if (typeof entry !== "object" || entry === null) {
			problems.push(`${at} must be an object`);
			return;
		}
		const field = (name: string): unknown => Reflect.get(entry, name);
		const env = field("env");
		if (typeof env !== "string" || !ENV_NAME.test(env)) {
			problems.push(`${at}.env must be an environment variable name`);
			return;
		}
		const fail = (problem: string) =>
			problems.push(`${at} (${env}): ${problem}; the value is withheld and not proxied`);
		if (withheld.has(env)) {
			fail("declared more than once");
			return;
		}
		withheld.add(env);
		const origin = parseOrigin(field("origin"));
		if ("problem" in origin) return fail(origin.problem);
		const rawHeader = field("header") ?? "authorization";
		if (
			typeof rawHeader !== "string" ||
			!HEADER_NAME.test(rawHeader) ||
			RESERVED_HEADERS.has(rawHeader.toLowerCase())
		)
			return fail("header must be a request header name the proxy may set");
		const header = rawHeader.toLowerCase();
		const rawScheme = field("scheme");
		if (rawScheme !== undefined && (typeof rawScheme !== "string" || !SCHEME.test(rawScheme)))
			return fail("scheme must be a single token such as Bearer");
		const scheme = typeof rawScheme === "string" ? rawScheme : header === "authorization" ? "Bearer" : undefined;
		const baseUrlEnv = field("baseUrlEnv");
		if (baseUrlEnv !== undefined && (typeof baseUrlEnv !== "string" || !ENV_NAME.test(baseUrlEnv)))
			return fail("baseUrlEnv must be an environment variable name");
		if (typeof baseUrlEnv === "string" && (baseUrlNames.has(baseUrlEnv) || baseUrlEnv === env))
			return fail("baseUrlEnv is already used");
		const prefixes = parsePathPrefixes(field("pathPrefixes"));
		if ("problem" in prefixes) return fail(prefixes.problem);
		if (typeof baseUrlEnv === "string") baseUrlNames.add(baseUrlEnv);
		credentials.push({
			env,
			origin: origin.origin,
			header,
			scheme,
			baseUrlEnv: typeof baseUrlEnv === "string" ? baseUrlEnv : undefined,
			pathPrefixes: prefixes.prefixes,
		});
	});
	for (const credential of credentials)
		if (withheld.has(credential.baseUrlEnv ?? ""))
			problems.push(`credentialProxy: ${credential.baseUrlEnv} is both a credential and a baseUrlEnv`);
	return { credentials, withheldNames: [...withheld], problems };
}
