import { interpolateValue } from "./config.ts";
import type { PlainMcpServerDeclaration } from "./config-references.ts";

/** Shared F4 fixture contract: finite names, never an LC_* or proxy wildcard. */
export const PROJECT_MCP_SAFE_BASE_NAMES = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"TMPDIR",
	"TMP",
	"TEMP",
	"TZ",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"LC_COLLATE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"LC_ADDRESS",
	"LC_IDENTIFICATION",
	"LC_MEASUREMENT",
	"LC_NAME",
	"LC_PAPER",
	"LC_TELEPHONE",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"USERNAME",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"PROGRAMFILES",
	"PROCESSOR_ARCHITECTURE",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
] as const;
type Environment = Readonly<Record<string, string | undefined>>;
const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
const inheritedExclusion = /^(?:npm|yarn|pnpm)[_-]/i;

export function lookupProjectEnv(
	env: Environment,
	name: string,
	windows = process.platform === "win32",
): string | undefined {
	if (!windows) return env[name];
	const upper = name.toUpperCase();
	if (env[upper] !== undefined) return env[upper];
	return Object.entries(env).find(([key]) => key.toUpperCase() === upper)?.[1];
}
export function mergeProjectEnv(
	layers: readonly Environment[],
	windows = process.platform === "win32",
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const layer of layers)
		for (const [key, value] of Object.entries(layer)) {
			if (value === undefined) continue;
			if (windows)
				for (const existing of Object.keys(result)) {
					if (existing.toUpperCase() === key.toUpperCase()) delete result[existing];
				}
			result[key] = value;
		}
	return result;
}
function inherited(ambient: Environment, names: readonly string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of names) {
		if (inheritedExclusion.test(name)) continue;
		const value = lookupProjectEnv(ambient, name);
		if (value !== undefined) result[name] = value;
	}
	return result;
}
/** Pure policy calculation; only `withheld` is allowed into diagnostics/logs. */
export function projectMcpEnvironment(
	raw: PlainMcpServerDeclaration,
	trusted: boolean,
	granted: readonly string[],
	explicit: Environment | undefined = undefined,
	ambient: Environment = process.env,
): { declaration: PlainMcpServerDeclaration; env: Record<string, string>; withheld: string[] } {
	const remote = (raw.type ?? (raw.url ? "http" : "stdio")) !== "stdio";
	const env = mergeProjectEnv([
		inherited(ambient, PROJECT_MCP_SAFE_BASE_NAMES),
		inherited(ambient, granted),
		explicit ?? {},
	]);
	const withheld = new Set<string>();
	const grantedName = (name: string) =>
		granted.some((entry) =>
			process.platform === "win32" ? entry.toUpperCase() === name.toUpperCase() : entry === name,
		);
	const expand = (value: string, field: string): string => {
		if (!remote && trusted && (value.trimStart().startsWith("!") || value.includes("$("))) {
			interpolateValue(value, `mcp.${field}`, {});
		}
		return value.replace(reference, (whole: string, name: string) => {
			if ((!remote && trusted) || grantedName(name)) {
				const expanded = interpolateValue(whole, `mcp.${field}`, {
					[name]: grantedName(name)
						? (lookupProjectEnv(explicit ?? {}, name) ?? lookupProjectEnv(ambient, name))
						: lookupProjectEnv(explicit ?? ambient, name),
				});
				if (typeof expanded !== "string") throw new TypeError("Invalid MCP interpolation");
				return expanded;
			}
			withheld.add(name);
			return whole;
		});
	};
	const mapping = (values: Record<string, string>, field: string) => {
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(values)) {
			result[key] = expand(value, `${field}.${key}`);
		}
		return result;
	};
	// Preserve absent fields: adding args:undefined would overwrite the
	// normalizer's default array when it spreads the declaration.
	const declaration: PlainMcpServerDeclaration = { ...raw };
	if (raw.command !== undefined) declaration.command = expand(raw.command, "command");
	if (raw.cwd !== undefined) declaration.cwd = expand(raw.cwd, "cwd");
	if (raw.args !== undefined) declaration.args = raw.args.map((arg) => expand(arg, "args"));
	if (raw.env !== undefined) declaration.env = mapping(raw.env, "env");
	if (raw.url !== undefined) declaration.url = expand(raw.url, "url");
	if (raw.headers !== undefined) declaration.headers = mapping(raw.headers, "headers");
	if (raw.oauth !== undefined) {
		declaration.oauth = { ...raw.oauth };
		if (raw.oauth.clientId !== undefined) declaration.oauth.clientId = expand(raw.oauth.clientId, "oauth.clientId");
		if (raw.oauth.clientMetadataUrl !== undefined) {
			declaration.oauth.clientMetadataUrl = expand(raw.oauth.clientMetadataUrl, "oauth.clientMetadataUrl");
		}
		if (raw.oauth.scopes !== undefined)
			declaration.oauth.scopes = raw.oauth.scopes.map((scope) => expand(scope, "oauth.scopes"));
	}
	const sendsBearer = raw.auth === "bearer" || (raw.auth === undefined && raw.bearerTokenEnv !== undefined);
	if (remote && sendsBearer && raw.bearerTokenEnv !== undefined && !grantedName(raw.bearerTokenEnv)) {
		withheld.add(raw.bearerTokenEnv);
		delete declaration.bearerTokenEnv;
		declaration.auth = false;
	}
	// Declared keys win over explicit values, including all Windows case variants.
	return { declaration, env: mergeProjectEnv([env, declaration.env ?? {}]), withheld: [...withheld].sort() };
}
