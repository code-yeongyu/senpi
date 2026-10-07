import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ClaudeCodeVersion = readonly [number, number, number];

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;
const VERSION_PROBE_TIMEOUT_MS = 5_000;

function parseClaudeCodeVersion(text: string | undefined): ClaudeCodeVersion | undefined {
	const match = text === undefined ? null : VERSION_PATTERN.exec(text);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True only when both versions parse and `candidate` is strictly newer than `baseline`. */
export function isNewerClaudeCodeVersion(candidate: string | undefined, baseline: string | undefined): boolean {
	const left = parseClaudeCodeVersion(candidate);
	const right = parseClaudeCodeVersion(baseline);
	if (left === undefined || right === undefined) return false;
	for (let index = 0; index < 3; index++) {
		if (left[index] !== right[index]) return left[index] > right[index];
	}
	return false;
}

const probedVersions = new Map<string, string | undefined>();

/** `<executable> --version`, once per path per process; `undefined` when the binary cannot say. */
export function probeClaudeCodeVersion(executable: string): string | undefined {
	if (probedVersions.has(executable)) return probedVersions.get(executable);
	let version: string | undefined;
	try {
		const output = execFileSync(executable, ["--version"], {
			encoding: "utf8",
			timeout: VERSION_PROBE_TIMEOUT_MS,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		version = VERSION_PATTERN.exec(output)?.[0];
	} catch {
		// A binary that cannot report its version never outranks the bundled one.
		version = undefined;
	}
	probedVersions.set(executable, version);
	return version;
}

export function bundledClaudeCodeVersion(): string | undefined {
	try {
		const entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
		const manifest: unknown = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("claudeCodeVersion" in manifest)) return undefined;
		return typeof manifest.claudeCodeVersion === "string" ? manifest.claudeCodeVersion : undefined;
	} catch {
		// A compiled build cannot read the SDK manifest; the caller probes the bundled binary instead.
		return undefined;
	}
}
