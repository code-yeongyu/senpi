/**
 * `Endpoint` split and the URL secret marking rule (custody design 4.1, row CK5).
 *
 * A provider `baseUrl` is split into its public parts, which travel as plain config, and its
 * secret parts, which are sealed one field each. Secret iff: `userinfo` (always); a path segment
 * or query value that is templated (`!command` or a `$VAR` reference, senpi's own template
 * syntax); a part the user listed in `secretUrlParts`; or a query value whose NAME is key-ish.
 * The key-ish list decides what is sealed, never the source digest.
 */

import { getConfigValueEnvVarNames, isCommandConfigValue } from "../resolve-config-value.ts";

export type UrlSecretField = "urlUserinfo" | `urlPath:${number}` | `urlQuery:${string}`;
export type MarkableUrlPart = `urlPath:${number}` | `urlQuery:${string}`;

export interface SecretUrlPart {
	readonly secret: true;
}

export interface Endpoint {
	readonly scheme: "http" | "https";
	readonly host: string;
	readonly port?: number;
	readonly path: readonly (string | SecretUrlPart)[];
	readonly query?: Readonly<Record<string, string | SecretUrlPart>>;
	readonly userinfo?: true;
}

export type EndpointSplit =
	| { readonly ok: true; readonly endpoint: Endpoint; readonly secrets: ReadonlyMap<UrlSecretField, string> }
	| {
			readonly ok: false;
			readonly reason: "unparseable" | "scheme" | "fragment" | "duplicate-query" | "valueless-query";
	  };

/** Query parameter names whose value is sealed whatever it looks like (compared case-insensitively). */
const KEYISH_QUERY_NAMES: readonly string[] = [
	"key",
	"api_key",
	"api-key",
	"apikey",
	"token",
	"access_token",
	"sig",
	"signature",
	"sv",
	"client_secret",
	"secret",
	"password",
	"auth",
	"authorization",
	"auth_token",
	"access-token",
	"subscription-key",
	"x-api-key",
];

const SECRET: SecretUrlPart = { secret: true };
const URL_SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?(?:\?([^#]*))?(#.*)?$/i;
const HOST_PORT = /^([^@/?#:[\]]+|\[[^\]]+\])(?::(\d+))?$/;

function isTemplatedUrlPart(raw: string): boolean {
	return isCommandConfigValue(raw) || getConfigValueEnvVarNames(raw).length > 0;
}

function isKeyishQueryName(name: string): boolean {
	return KEYISH_QUERY_NAMES.includes(name.toLowerCase());
}

export function splitEndpoint(baseUrl: string, secretUrlParts: readonly MarkableUrlPart[] = []): EndpointSplit {
	const match = URL_SHAPE.exec(baseUrl);
	if (!match) return { ok: false, reason: "unparseable" };
	const [, rawScheme, authority = "", rawPath, rawQuery, fragment] = match;
	const at = authority.lastIndexOf("@");
	const userinfo = at === -1 ? undefined : authority.slice(0, at);
	const hostPort = HOST_PORT.exec(at === -1 ? authority : authority.slice(at + 1));
	const host = hostPort?.[1];
	const port = hostPort?.[2];
	if (rawScheme === undefined || host === undefined) return { ok: false, reason: "unparseable" };
	if (fragment !== undefined) return { ok: false, reason: "fragment" };
	const scheme = rawScheme.toLowerCase();
	if (scheme !== "http" && scheme !== "https") return { ok: false, reason: "scheme" };
	const marked = new Set<string>(secretUrlParts);
	const secrets = new Map<UrlSecretField, string>();

	if (userinfo !== undefined) secrets.set("urlUserinfo", userinfo);

	const path = (rawPath ?? "").split("/").slice(1);
	const publicPath = path.map((segment, index): string | SecretUrlPart => {
		const field: UrlSecretField = `urlPath:${index}`;
		if (!isTemplatedUrlPart(segment) && !marked.has(field)) return segment;
		secrets.set(field, segment);
		return SECRET;
	});

	let query: Record<string, string | SecretUrlPart> | undefined;
	if (rawQuery !== undefined) {
		query = {};
		for (const pair of rawQuery.length > 0 ? rawQuery.split("&") : []) {
			const separator = pair.indexOf("=");
			if (separator < 1) return { ok: false, reason: "valueless-query" };
			const name = pair.slice(0, separator);
			const value = pair.slice(separator + 1);
			if (Object.hasOwn(query, name)) return { ok: false, reason: "duplicate-query" };
			const field: UrlSecretField = `urlQuery:${name}`;
			if (isKeyishQueryName(name) || isTemplatedUrlPart(value) || marked.has(field)) {
				secrets.set(field, value);
				query[name] = SECRET;
			} else {
				query[name] = value;
			}
		}
	}

	const endpoint: Endpoint = {
		scheme,
		host,
		...(port !== undefined ? { port: Number(port) } : {}),
		path: publicPath,
		...(query !== undefined ? { query } : {}),
		...(userinfo !== undefined ? { userinfo: true } : {}),
	};
	return { ok: true, endpoint, secrets };
}

export function composeEndpointUrl(endpoint: Endpoint, secret: (field: UrlSecretField) => string): string {
	const userinfo = endpoint.userinfo ? `${secret("urlUserinfo")}@` : "";
	const port = endpoint.port !== undefined ? `:${endpoint.port}` : "";
	const path = endpoint.path
		.map((segment, index) => (typeof segment === "string" ? segment : secret(`urlPath:${index}`)))
		.map((segment) => `/${segment}`)
		.join("");
	const query =
		endpoint.query === undefined
			? ""
			: `?${Object.entries(endpoint.query)
					.map(([name, value]) => `${name}=${typeof value === "string" ? value : secret(`urlQuery:${name}`)}`)
					.join("&")}`;
	return `${endpoint.scheme}://${userinfo}${endpoint.host}${port}${path}${query}`;
}
