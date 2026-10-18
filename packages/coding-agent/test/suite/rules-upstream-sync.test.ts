/**
 * Regressions for the pi-rules 0.2.0 fixes ported into the vendored `rules` builtin
 * (tracking issue senpi#2079). Every scenario uses a real temp filesystem so discovery,
 * realpath canonicalization and the git-root walk run exactly as in a session.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import piRulesExtension from "../../src/core/extensions/builtin/rules/index.ts";
import { createEngine, defaultConfig } from "../../src/core/extensions/builtin/rules/rules/engine.ts";
import { findRuleCandidates } from "../../src/core/extensions/builtin/rules/rules/finder.ts";
import { findProjectRoot, widenToRepositoryRoot } from "../../src/core/extensions/builtin/rules/rules/project-root.ts";
import { extractToolPaths } from "../../src/core/extensions/builtin/rules/rules/tool-paths.ts";
import { renderBannerLines } from "../../src/core/extensions/builtin/rules/ui/rules-banner.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
	ToolResultEvent,
} from "../../src/core/extensions/types.ts";
import { testTheme } from "./history-search-fixtures.ts";

let root: string;

function writeFile(relativePath: string, content: string): string {
	const filePath = join(root, relativePath);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function createRealEngine() {
	return createEngine(defaultConfig(), {
		findCandidates: (options) => findRuleCandidates({ ...options, skipUserHome: true }),
		readFile: (path) => {
			try {
				return readFileSync(path, "utf-8");
			} catch {
				return null;
			}
		},
		findProjectRoot,
		extractToolPaths,
	});
}

beforeEach(() => {
	// realpath: os.tmpdir() is a symlink into /private/var on macOS.
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "senpi-rules-sync-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("rules finder", () => {
	it("discovers native .pi/rules in the project and the user home, ahead of .omo/rules", () => {
		writeFile("project/.git/HEAD", "ref: refs/heads/main\n");
		writeFile("project/.pi/rules/pi.md", "---\nalwaysApply: true\n---\nPi rule\n");
		writeFile("project/.omo/rules/omo.md", "---\nalwaysApply: true\n---\nOmo rule\n");
		writeFile("home/.pi/rules/home.md", "---\nalwaysApply: true\n---\nHome rule\n");

		const candidates = findRuleCandidates({
			projectRoot: join(root, "project"),
			targetFile: null,
			homeDir: join(root, "home"),
		});

		expect(candidates.map((candidate) => candidate.source)).toEqual(
			expect.arrayContaining([".pi/rules", ".omo/rules", "~/.pi/rules"]),
		);
	});

	it("keeps only the first existing user-home single-file rule", () => {
		writeFile("home/.config/opencode/AGENTS.md", "opencode agents\n");
		writeFile("home/.claude/CLAUDE.md", "claude\n");

		const candidates = findRuleCandidates({ projectRoot: null, targetFile: null, homeDir: join(root, "home") });

		expect(candidates.filter((candidate) => candidate.isSingleFile).map((candidate) => candidate.source)).toEqual([
			"~/.config/opencode/AGENTS.md",
		]);
	});
});

describe("rules project root", () => {
	it("resolves a symlinked start path to the real project root", () => {
		writeFile("real/package.json", "{}\n");
		writeFile("real/src/index.ts", "export {};\n");
		symlinkSync(join(root, "real"), join(root, "link"), "dir");

		expect(findProjectRoot(join(root, "link", "src", "index.ts"))).toBe(join(root, "real"));
	});

	it("widens a nested workspace member to the enclosing git repository root", () => {
		writeFile("repo/.git/HEAD", "ref: refs/heads/main\n");
		writeFile("repo/Cargo.toml", "[workspace]\n");
		writeFile("repo/crates/member/Cargo.toml", "[package]\n");

		expect(widenToRepositoryRoot(join(root, "repo", "crates", "member"))).toBe(join(root, "repo"));
		expect(widenToRepositoryRoot(null)).toBeNull();
	});

	it("keeps the marker root when no git repository encloses it", () => {
		writeFile("plain/member/package.json", "{}\n");

		expect(widenToRepositoryRoot(join(root, "plain", "member"))).toBe(join(root, "plain", "member"));
	});
});

describe("rules engine dynamic discovery", () => {
	it("reaches repository-level instructions from a workspace member", () => {
		writeFile("repo/.git/HEAD", "ref: refs/heads/main\n");
		writeFile("repo/Cargo.toml", "[workspace]\n");
		writeFile("repo/.github/instructions/rust.instructions.md", '---\napplyTo: "crates/**/*.rs"\n---\nREPO-RUST\n');
		writeFile("repo/crates/member/Cargo.toml", "[package]\n");
		const target = writeFile("repo/crates/member/src/lib.rs", "pub fn f() {}\n");

		const loaded = createRealEngine().loadDynamicRules(join(root, "repo"), [target]);

		expect(loaded.rules.map((rule) => rule.body.trim())).toContain("REPO-RUST");
	});

	it("selects only the higher-priority root single-file rule for a nested target", () => {
		writeFile("proj/package.json", "{}\n");
		writeFile("proj/AGENTS.md", "ROOT-AGENTS\n");
		writeFile("proj/CLAUDE.md", "ROOT-CLAUDE\n");
		const target = writeFile("proj/src/deep/index.ts", "export {};\n");

		const loaded = createRealEngine().loadDynamicRules(join(root, "proj"), [target]);

		expect(loaded.rules.filter((rule) => rule.isSingleFile).map((rule) => rule.source)).toEqual(["AGENTS.md"]);
	});
});

interface FakeHost {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	readonly commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
}

function createFakeHost(): FakeHost {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const flags = new Map<string, boolean | string>([
		["pi-rules-disabled", false],
		["pi-rules-mode", "both"],
	]);
	const host = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: () => {},
		getFlag: (name: string) => flags.get(name),
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		},
		registerEntryRenderer: () => {},
		appendEntry: () => {},
	};
	return { pi: host as unknown as ExtensionAPI, handlers, commands };
}

async function emit(host: FakeHost, event: string, payload: unknown, ctx: unknown): Promise<unknown> {
	let result: unknown;
	for (const handler of host.handlers.get(event) ?? []) result = await handler(payload, ctx);
	return result;
}

describe("rules extension", () => {
	it("does not re-inject a natively loaded ancestor AGENTS.md reached by the repository walk", async () => {
		writeFile("repo/.git/HEAD", "ref: refs/heads/main\n");
		const rootAgents = writeFile("repo/AGENTS.md", "ROOT-AGENTS-NATIVE\n");
		writeFile("repo/.github/instructions/ts.instructions.md", '---\napplyTo: "packages/**/*.ts"\n---\nREPO-TS\n');
		writeFile("repo/packages/app/package.json", "{}\n");
		const target = writeFile("repo/packages/app/src/main.ts", "export {};\n");
		const cwd = join(root, "repo", "packages", "app");
		const host = createFakeHost();
		piRulesExtension(host.pi);
		const ctx = { cwd, hasUI: false, ui: { notify: () => {} } };

		await emit(host, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await emit(
			host,
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "read main.ts",
				systemPrompt: "BASE",
				systemPromptOptions: { cwd, contextFiles: [{ path: rootAgents, content: "ROOT-AGENTS-NATIVE\n" }] },
			},
			ctx,
		);
		const event: ToolResultEvent = {
			type: "tool_result",
			toolName: "read",
			toolCallId: "call-read-main",
			input: { path: target },
			content: [{ type: "text", text: "export {};" }],
			details: undefined,
			isError: false,
		};
		const result = (await emit(host, "tool_result", event, ctx)) as
			| { content: Array<{ type: string; text?: string }> }
			| undefined;
		const text = (result?.content ?? []).map((block) => block.text ?? "").join("\n");

		expect(text).toContain("REPO-TS");
		expect(text).not.toContain("ROOT-AGENTS-NATIVE");
	});

	it("rejects /rules show without a rule id", async () => {
		const host = createFakeHost();
		piRulesExtension(host.pi);
		const notices: Array<{ message: string; severity: string | undefined }> = [];
		const ctx = {
			cwd: root,
			ui: { notify: (message: string, severity?: string) => notices.push({ message, severity }) },
		} as unknown as ExtensionCommandContext;

		await host.commands.get("rules")?.handler("show", ctx);

		expect(notices).toEqual([{ message: "Rule ID is required", severity: "error" }]);
	});
});

describe("rules banner", () => {
	it("flags a rule whose diagnostic names its absolute path", () => {
		const lines = renderBannerLines(
			{
				ruleCount: 1,
				diagnostics: [{ source: "/repo/.omo/rules/broken.md", message: "bad frontmatter", severity: "warning" }],
				topRules: [
					{ path: "/repo/.omo/rules/broken.md", relativePath: ".omo/rules/broken.md", matchReason: "alwaysApply" },
				],
			},
			testTheme,
			80,
		).join("\n");

		expect(lines).toContain("⚠ .omo/rules/broken.md");
	});
});
