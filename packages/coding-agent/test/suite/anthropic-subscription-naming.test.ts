import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const builtinRoot = join(packageRoot, "src", "core", "extensions", "builtin");
const repoRoot = join(packageRoot, "..", "..");
const SCAN_ROOTS = [join(packageRoot, "src"), join(repoRoot, "packages", "ai", "src")];

/** The legacy spellings a user must never read on a shipped surface. */
const LEGACY_PATTERNS = [/openai-codex/i, /OpenAI Codex/, /claude-sdk-oauth/i, /Claude SDK OAuth/];

/**
 * Every literal that may still carry a legacy spelling, keyed by the file that
 * owns it and paired with WHY it is frozen. Pairing file+literal (rather than
 * allowlisting whole files) keeps the gate sharp: a NEW legacy string in one of
 * these files still fails.
 */
const ALLOWED: ReadonlyArray<{ file: string; literal: string; why: string }> = [
	// The wire api id names the dialect, not the provider, and is persisted on every stored model.
	{ file: "anthropic-subscription/api-id.ts", literal: "claude-sdk-oauth", why: "frozen wire api id" },
	{
		file: "goal/terminal-provider-error.ts",
		literal: "claude-sdk-oauth",
		why: "compares model.api, the frozen wire id",
	},
	{ file: "utils/prompt-cache-ttl.ts", literal: "claude-sdk-oauth", why: "switches on model.api, the frozen wire id" },
	// Frozen persisted tokens: renaming any breaks resume or auth for existing users.
	{
		file: "anthropic-subscription/affinity.ts",
		literal: "claude-sdk-oauth-default",
		why: "persisted HRW affinity key",
	},
	{
		file: "anthropic-subscription/session-binding.ts",
		literal: "claude-sdk-oauth-binding",
		why: "persisted binding entry type",
	},
	{
		file: "anthropic-subscription/config-dir-credentials.ts",
		literal: "claude-sdk-oauth-accounts",
		why: "the legacy accounts dir the one-shot move reads from",
	},
	// The builtin registry id is a stable module identifier, not a display name.
	{ file: "extensions/builtin/index.ts", literal: "claude-sdk-oauth", why: "builtin extension module id" },
	// KnownProvider deliberately retains the legacy union member.
	{ file: "packages/ai/src/types.ts", literal: "openai-codex", why: "retained KnownProvider legacy member" },
];

/** Substrings that are allowed anywhere, because the string IS the frozen contract. */
const ALLOWED_ANYWHERE = [
	"openai-codex-responses",
	"claude-sdk-oauth-managed",
	"claude-sdk-oauth-compact",
	"senpi.claude-sdk-oauth.compact-boundary.v1",
	".claude-sdk-oauth-binding.json",
	"claude-sdk-oauth-tool-watch",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"SENPI_CLAUDE_SDK_OAUTH",
	"claude_sdk_oauth_",
	// The todo-9 rejection message must NAME the old id back to the user.
	"was renamed to",
];

/** Files whose entire purpose is to know the legacy ids. */
const ALLOWED_FILES = [
	join("packages", "ai", "src", "legacy-provider-ids.ts"),
	join("packages", "ai", "src", "legacy-api-aliases.ts"),
	join("src", "core", "auth-provider-key-migration.ts"),
	join("src", "core", "settings-manager.ts"),
];

function sourceFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				if (entry === "node_modules" || entry === "dist") continue;
				walk(p);
				continue;
			}
			if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
		}
	};
	walk(root);
	return out;
}

/** Quoted string and template literals only — comments and identifiers are not user-facing. */
function stringLiterals(source: string): string[] {
	return (source.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? []).map((s) => s.slice(1, -1));
}

describe("anthropic subscription naming boundary", () => {
	it("renames the internal provider path without renaming the upstream package", () => {
		expect(existsSync(join(builtinRoot, "anthropic-subscription", "index.ts"))).toBe(true);
		expect(existsSync(join(builtinRoot, "claude-sdk-oauth", "index.ts"))).toBe(false);
		expect(existsSync(join(builtinRoot, "claude-agent-sdk", "index.ts"))).toBe(false);

		const packageJson = readFileSync(join(packageRoot, "package.json"), "utf8");
		expect(packageJson).toContain('"@anthropic-ai/claude-agent-sdk":');
		expect(packageJson).not.toContain('"@anthropic-ai/claude-sdk-oauth"');
	});

	it("ships no string literal carrying a legacy provider name outside the allowlist", () => {
		const leaks: string[] = [];
		for (const root of SCAN_ROOTS) {
			for (const file of sourceFiles(root)) {
				const relative = file.slice(repoRoot.length + 1);
				if (ALLOWED_FILES.some((allowed) => relative.endsWith(allowed))) continue;
				for (const literal of stringLiterals(readFileSync(file, "utf8"))) {
					if (!LEGACY_PATTERNS.some((pattern) => pattern.test(literal))) continue;
					if (ALLOWED_ANYWHERE.some((allowed) => literal.includes(allowed))) continue;
					if (ALLOWED.some((entry) => relative.includes(entry.file) && literal.includes(entry.literal))) continue;
					leaks.push(`${relative}: ${literal.slice(0, 120)}`);
				}
			}
		}
		// Named so a failure points straight at the file and the offending literal.
		expect(leaks).toEqual([]);
	});

	it("keeps the legacy ids reachable where they are load-bearing", () => {
		const legacyMap = readFileSync(join(repoRoot, "packages", "ai", "src", "legacy-provider-ids.ts"), "utf8");
		// Both map KEYS must survive: every normalization and every typed rejection reads them.
		expect(legacyMap).toContain('"openai-codex": "chatgpt-subscription"');
		expect(legacyMap).toContain('"claude-sdk-oauth": "anthropic-subscription"');
	});
});
