import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIAL_ENV_VARS } from "@earendil-works/pi-ai";

type ParsedDotenvEntry = {
	readonly key: string;
	readonly value: string;
	readonly rawValue: string;
};

function dotenvFilenames(nodeEnv: string | undefined): readonly string[] {
	const names = [".env", ".env.local", ".env.development", ".env.development.local"];
	if (!nodeEnv) return names;
	return [...new Set([...names, `.env.${nodeEnv}`, `.env.${nodeEnv}.local`])];
}

function stripInlineComment(value: string): string {
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if ((char === "'" || char === '"') && (i === 0 || value[i - 1] !== "\\")) {
			quote = quote === char ? undefined : (quote ?? char);
		}
		if (char === "#" && quote === undefined && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
			return value.slice(0, i).trim();
		}
	}
	return value.trim();
}

function unquote(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}

function parseDotenv(content: string): readonly ParsedDotenvEntry[] {
	const entries: ParsedDotenvEntry[] = [];
	for (const rawLine of content.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trim();
		if (!line || line.startsWith("#")) continue;
		const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
		const separatorIndex = withoutExport.indexOf("=");
		if (separatorIndex <= 0) continue;
		const key = withoutExport.slice(0, separatorIndex).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		const rawValue = stripInlineComment(withoutExport.slice(separatorIndex + 1));
		entries.push({ key, value: unquote(rawValue), rawValue });
	}
	return entries;
}

function readProjectDotenvEntries(dotenvDir: string, nodeEnv: string | undefined): readonly ParsedDotenvEntry[] {
	const entries: ParsedDotenvEntry[] = [];
	for (const filename of dotenvFilenames(nodeEnv)) {
		const path = join(dotenvDir, filename);
		if (!existsSync(path)) continue;
		entries.push(...parseDotenv(readFileSync(path, "utf-8")));
	}
	return entries;
}

export function collectInjectedCredentialKeys(
	dotenvDir: string,
	env: Readonly<Record<string, string | undefined>>,
	credentialVars: readonly string[],
): string[] {
	const credentialSet = new Set(credentialVars);
	const injected = new Set<string>();
	for (const entry of readProjectDotenvEntries(dotenvDir, env.NODE_ENV)) {
		if (!credentialSet.has(entry.key)) continue;
		const current = env[entry.key];
		if (current === undefined) continue;
		if (current === entry.value || entry.rawValue.includes("${")) {
			injected.add(entry.key);
		}
	}
	return [...injected];
}

export function stripProjectDotenv(): void {
	if (!process.versions?.bun) return;

	const injected = collectInjectedCredentialKeys(process.cwd(), process.env, CREDENTIAL_ENV_VARS);
	for (const key of injected) {
		delete process.env[key];
	}

	// `/proc/self/environ` is the execve-time snapshot. Bun dotenv injection happens
	// after exec and leaves process.env non-empty, so env-api-keys' proc fallback does not reintroduce stripped keys.
}
