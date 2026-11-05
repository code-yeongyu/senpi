import { readFileSync } from "node:fs";
import { getAgentDir } from "../../../../../config.ts";
import { parseSettingsJson, resolveSettingsSource } from "../../../../settings-manager.ts";

/**
 * The user's opt-in for reading listed hosts through their signed-in browser (senpi#5940). Read only
 * from the GLOBAL settings file, parse-only (no migration, no write), so a repository's
 * `.senpi/settings.json` can never turn it on and a tool call never rewrites the user's settings. The
 * model gets no parameter for it.
 *
 * `{ "webfetch": { "signedInBrowser": { "hosts": ["wiki.example.com", "*.corp.example"], "browser": "Work Chrome" } } }`
 */
export const SIGNED_IN_HOSTS_SETTING = "webfetch.signedInBrowser.hosts";

export interface SignedInBrowserSettings {
	readonly hosts: readonly string[];
	readonly browser?: string;
}

// ASCII host labels only. A wildcard is refused on a single label ("*.com"), on a country second-level
// domain ("*.co.uk", "*.com.tw": a generic second label under a two-letter country code), and on the shared
// hosting suffixes listed below ("*.github.io"). This is not a full public suffix list: a suffix outside
// these rules is accepted, and only the user can add a host.
const HOST_PATTERN = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u;
// Shared hosting suffixes a wildcard must sit below, not on.
const PUBLIC_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"ac.uk",
	"gov.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.jp",
	"or.jp",
	"ne.jp",
	"co.kr",
	"or.kr",
	"com.br",
	"com.cn",
	"com.mx",
	"co.in",
	"co.nz",
	"co.za",
	"github.io",
	"gitlab.io",
	"pages.dev",
	"workers.dev",
	"vercel.app",
	"netlify.app",
	"herokuapp.com",
	"azurewebsites.net",
	"cloudfront.net",
	"s3.amazonaws.com",
	"appspot.com",
	"web.app",
	"firebaseapp.com",
	"amazonaws.com",
	"blogspot.com",
	"ngrok.io",
	"ngrok-free.app",
]);
// Generic second labels that, under a two-letter country code, form a country's public second level.
const COUNTRY_SECOND_LEVELS = new Set(["com", "co", "org", "net", "ac", "or", "ne", "go", "gov", "edu", "mil", "gob"]);
const IPV4 = /^\d+(?:\.\d+){0,3}$|^0x[0-9a-f]+$/u;

function isWildcardTooBroad(pattern: string): boolean {
	if (!pattern.startsWith("*.")) return false;
	const base = pattern.slice(2);
	const labels = base.split(".");
	if (labels.length < 2 || PUBLIC_SUFFIXES.has(base)) return true;
	if (labels.length !== 2) return false;
	const [second = "", top = ""] = labels;
	return top.length === 2 && COUNTRY_SECOND_LEVELS.has(second);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

export function parseSignedInBrowserSettings(globalSettings: unknown): SignedInBrowserSettings {
	const signedIn = record(record(record(globalSettings)?.webfetch)?.signedInBrowser);
	const hosts = Array.isArray(signedIn?.hosts)
		? signedIn.hosts
				.filter((host): host is string => typeof host === "string")
				.map((host) => host.trim().toLowerCase())
				.filter((host) => HOST_PATTERN.test(host) && !isWildcardTooBroad(host) && !IPV4.test(host))
		: [];
	const browser =
		typeof signedIn?.browser === "string" && signedIn.browser.trim() ? signedIn.browser.trim() : undefined;
	return browser === undefined ? { hosts } : { hosts, browser };
}

/** Reads the global settings file without loading a SettingsManager (whose load can migrate and write it). */
export function readSignedInBrowserSettings(agentDir: string = getAgentDir()): SignedInBrowserSettings {
	const source = resolveSettingsSource(agentDir, agentDir, "global");
	if (!source) return { hosts: [] };
	try {
		return parseSignedInBrowserSettings(parseSettingsJson(readFileSync(source.path, "utf8")));
	} catch {
		return { hosts: [] };
	}
}

/** `example.com` matches that host only; `*.example.com` matches its subdomains. Only http(s) URLs match. */
export function isSignedInHost(url: string, hosts: readonly string[]): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
	const host = parsed.hostname.toLowerCase();
	// An IP literal is never a listed host: 127.0.0.1, and the forms URL normalizes to it (2130706433, 0x7f.0.0.1).
	if (host.endsWith(".") || host.startsWith("[") || IPV4.test(host)) return false;
	return hosts.some((pattern) =>
		pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern,
	);
}
