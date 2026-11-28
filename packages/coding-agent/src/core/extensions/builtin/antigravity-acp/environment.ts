import { existsSync } from "node:fs";
import type { AntigravityAuthMethod } from "./settings.ts";

const AGY_ENVIRONMENT_ALLOWLIST = [
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PATH",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	"DBUS_SESSION_BUS_ADDRESS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"SYSTEMROOT",
] as const;

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

export type AgyEnvironmentOptions = {
	readonly authMethod?: AntigravityAuthMethod;
	readonly platform?: NodeJS.Platform;
	readonly uid?: number;
	readonly pathExists?: (path: string) => boolean;
};

function mergeNoProxy(upper: string | undefined, lower: string | undefined): string {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const raw of [upper, lower]) {
		if (!raw) continue;
		for (const part of raw.split(",")) {
			const trimmed = part.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			merged.push(trimmed);
		}
	}
	for (const host of LOOPBACK_HOSTS) {
		if (!seen.has(host)) {
			seen.add(host);
			merged.push(host);
		}
	}
	return merged.join(",");
}

export function agyChildEnvironment(
	parent: Record<string, string | undefined> = process.env,
	options: AgyEnvironmentOptions = {},
): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const name of AGY_ENVIRONMENT_ALLOWLIST) {
		const value = parent[name];
		if (value !== undefined) environment[name] = value;
	}

	const platform = options.platform ?? process.platform;
	if (platform === "linux" && (!environment.XDG_RUNTIME_DIR || !environment.DBUS_SESSION_BUS_ADDRESS)) {
		const uid = options.uid ?? process.getuid?.();
		const pathExists = options.pathExists ?? existsSync;
		if (uid !== undefined) {
			const runtimeDir = environment.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
			if (!environment.XDG_RUNTIME_DIR && pathExists(runtimeDir)) {
				environment.XDG_RUNTIME_DIR = runtimeDir;
			}
			const busPath = `${runtimeDir}/bus`;
			if (!environment.DBUS_SESSION_BUS_ADDRESS && pathExists(busPath)) {
				environment.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`;
			}
		}
	}

	const noProxy = mergeNoProxy(parent.NO_PROXY, parent.no_proxy);
	environment.NO_PROXY = noProxy;
	environment.no_proxy = noProxy;
	environment.AGY_CLI_DISABLE_AUTO_UPDATE = "1";

	if (options.authMethod === "gemini-api-key") {
		if (parent.GEMINI_API_KEY !== undefined) environment.GEMINI_API_KEY = parent.GEMINI_API_KEY;
	} else if (options.authMethod === "agent-platform") {
		for (const key of ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"] as const) {
			const value = parent[key];
			if (value !== undefined) environment[key] = value;
		}
	}

	return environment;
}
