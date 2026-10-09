import type { RuleSource } from "./types.ts";

/**
 * Project root marker files / directories used by `findProjectRoot`.
 * Walks UP from cwd until any of these is found in the directory.
 */
export const PROJECT_MARKERS: readonly string[] = [
	".git",
	"pnpm-workspace.yaml",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	".venv",
];

/**
 * Project rule subdirectories. First tuple element is the parent dir under
 * the project root, second is the subdir scanned recursively.
 */
export const PROJECT_RULE_SUBDIRS: ReadonlyArray<readonly [string, string]> = [
	[".pi", "rules"],
	[".omo", "rules"],
	[".claude", "rules"],
	[".cursor", "rules"],
	[".github", "instructions"],
];

/**
 * Single-file project rules (always apply, frontmatter optional).
 */
export const PROJECT_SINGLE_FILES: readonly string[] = [
	".github/copilot-instructions.md",
	"AGENTS.md",
	"CLAUDE.md",
	"CONTEXT.md",
];

/**
 * User-home rule directories.
 */
export const USER_HOME_RULE_SUBDIRS: readonly string[] = [
	".pi/rules",
	".omo/rules",
	".opencode/rules",
	".claude/rules",
];

/**
 * User-home single-file rules. The first one to exist wins per "first-match" semantics.
 */
export const USER_HOME_SINGLE_FILES: readonly string[] = [".config/opencode/AGENTS.md", ".claude/CLAUDE.md"];

/**
 * File extensions accepted as rule files in scanned directories.
 */
export const RULE_FILE_EXTENSIONS: readonly string[] = [".md", ".mdc"];

/**
 * Per-rule source priority for deterministic ordering. Lower = earlier.
 */
export const SOURCE_PRIORITY: ReadonlyMap<RuleSource, number> = new Map([
	[".pi/rules", 0],
	[".omo/rules", 1],
	[".claude/rules", 2],
	[".cursor/rules", 3],
	[".github/instructions", 4],
	[".github/copilot-instructions.md", 5],
	["AGENTS.md", 6],
	["CLAUDE.md", 7],
	["CONTEXT.md", 8],
	["~/.pi/rules", 100],
	["~/.omo/rules", 101],
	["~/.opencode/rules", 102],
	["~/.claude/rules", 103],
	["~/.config/opencode/AGENTS.md", 104],
	["~/.claude/CLAUDE.md", 105],
]);

/**
 * Distance value assigned to global / user-home rules.
 */
export const GLOBAL_DISTANCE = 9999;

/**
 * Per-rule body character cap (default).
 */
export const DEFAULT_MAX_RULE_CHARS = 12000;

/**
 * Total injected chars per tool result (default).
 */
export const DEFAULT_MAX_RESULT_CHARS = 40000;

/**
 * Truncation marker template. `{path}` is replaced with the relative path.
 */
export const TRUNCATION_NOTICE = "\n\n[Rule truncated. Read full rule: {path}]";

/**
 * Built-in tool names whose results trigger dynamic rule injection.
 */
export const TRACKED_BUILTIN_TOOLS: readonly string[] = ["read", "edit", "write"];
export const TRACKED_BUILTIN_TOOL_SET: ReadonlySet<string> = new Set(TRACKED_BUILTIN_TOOLS);

/** Addressed to the model; never used to locate the block. */
export const PROJECT_RULES_START_MARKER = "<project_rules>";
export const PROJECT_RULES_END_MARKER = "</project_rules>";
export const PROJECT_RULES_HEADING = "## Project Instructions";

/**
 * How provider lanes that rebuild the system prompt (see the Anthropic Subscription builtin) locate the
 * block. The semantic markers cannot: prompt content this builtin does not own - context files
 * before it, extensions appending after it - may legitimately contain them and be extracted instead.
 */
export const PROJECT_RULES_REGION_START_MARKER = "<!--senpi:project-rules:1:start-->";
export const PROJECT_RULES_REGION_END_MARKER = "<!--senpi:project-rules:1:end-->";

/**
 * Directories excluded by the recursive scanner regardless of glob settings.
 */
export const SCANNER_EXCLUDED_DIRS: readonly string[] = [
	"node_modules",
	".git",
	"dist",
	"build",
	".turbo",
	".next",
	"coverage",
];
