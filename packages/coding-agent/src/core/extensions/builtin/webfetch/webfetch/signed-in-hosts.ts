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

// ASCII host labels only; a wildcard needs at least two labels after "*.", so "*.com" never enables a whole TLD.
const HOST_PATTERN = /^(?:\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)+|[a-z0-9-]+(?:\.[a-z0-9-]+)*)$/u;

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
				.filter((host) => HOST_PATTERN.test(host))
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
	if (host.endsWith(".") || host.startsWith("[")) return false;
	return hosts.some((pattern) =>
		pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern,
	);
}
