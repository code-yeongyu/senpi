import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveReadPath } from "../tools/path-utils.ts";

function identityPath(raw: string, cwd: string): string | undefined {
	if (!raw || raw.includes("\0")) return undefined;
	const home = process.env.HOME || homedir();
	const expanded = raw.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, () => home);
	const path = isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`;
	const identities = [
		join(home, ".omo/device-identity.json"),
		join(home, ".omo/device-service/device-identity.json"),
		join(home, ".config/typevault/identity.json"),
		...(process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, "typevault/identity.json")] : []),
	];
	const lexical = resolve(path).toLowerCase();
	const exact = identities.find((name) => name.toLowerCase() === lexical);
	if (exact) return exact;
	// Compare the files the OS would open (including symlink/../ semantics), never their contents.
	const file = statSync(path, { throwIfNoEntry: false, bigint: true });
	if (!file?.isFile()) return undefined;
	return identities.find((name) => {
		const identity = statSync(name, { throwIfNoEntry: false, bigint: true });
		return identity?.dev === file.dev && identity.ino === file.ino;
	});
}

export function refusedIdentityRead(name: string, params: unknown, root: string): string | undefined {
	if (!params || typeof params !== "object") return undefined;
	if (name === "read" || name === "grep") {
		const path = "path" in params ? params.path : undefined;
		if (typeof path !== "string") return undefined;
		const expanded = path.replace(/^\$(?:HOME|\{HOME\})(?=\/)/, () => process.env.HOME || homedir());
		return identityPath(name === "read" ? resolveReadPath(expanded, root) : expanded, root);
	}
	if (name !== "eval" && name !== "bash" && name !== "monitor") return undefined;
	const script = "code" in params ? params.code : "command" in params ? params.command : undefined;
	if (typeof script !== "string") return undefined;
	const cwd = "cwd" in params && typeof params.cwd === "string" ? resolve(root, params.cwd) : root;
	for (const match of script.matchAll(
		/\b(?:open|readText|readFile(?:Sync)?|Bun\.file)\s*\(\s*(?:(?:os\.path\.expanduser|Path)\s*\(\s*)?(["'`])([^"'`\r\n]+)\1/g,
	)) {
		if (match[2]) {
			const path = identityPath(match[2], cwd);
			if (path) return path;
		}
	}
	for (const match of script.matchAll(
		/(?:^|[;&|\n]|\bshell\(\s*["'`])\s*(?:\/[^\s;|&]*\/)?(cat|jq|grep|rg)\s+([^;|&\n]*)/g,
	)) {
		const words = (match[2] ?? "").match(/"[^"]*"|'[^']*'|[^\s"'`)]+/g) ?? [];
		let skipPattern = match[1] !== "cat";
		for (const word of words) {
			if (word.startsWith("-")) continue;
			if (skipPattern) {
				skipPattern = false;
				continue;
			}
			const path = identityPath(word.replace(/^(['"])(.*)\1$/, "$2"), cwd);
			if (path) return path;
		}
	}
	return undefined;
}
