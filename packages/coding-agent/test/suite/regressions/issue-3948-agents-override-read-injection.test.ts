/**
 * `AGENTS.override.md` replaces `AGENTS.md` / `CLAUDE.md` from its own directory in the native
 * context loader. The read-time injectors (`rules`, `nested-agents-md`) must apply the same rule,
 * otherwise the file the override shadows still reaches the model.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectDirectoryContext } from "../../../src/core/extensions/builtin/nested-agents-md/core/inject-directory-context.ts";
import { InjectionCache } from "../../../src/core/extensions/builtin/nested-agents-md/core/injection-cache.ts";
import piRulesExtension from "../../../src/core/extensions/builtin/rules/index.ts";
import { createEngine, defaultConfig } from "../../../src/core/extensions/builtin/rules/rules/engine.ts";
import { findRuleCandidates } from "../../../src/core/extensions/builtin/rules/rules/finder.ts";
import { findProjectRoot } from "../../../src/core/extensions/builtin/rules/rules/project-root.ts";
import { extractToolPaths } from "../../../src/core/extensions/builtin/rules/rules/tool-paths.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

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

function bodies(rules: ReadonlyArray<{ body: string }>): string[] {
	return rules.map((rule) => rule.body.trim());
}

beforeEach(() => {
	// realpath: os.tmpdir() is a symlink into /private/var on macOS.
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "senpi-agents-override-")));
	writeFile("repo/.git/HEAD", "ref: refs/heads/main\n");
	writeFile("repo/AGENTS.md", "TEAM-ROOT\n");
	writeFile("repo/AGENTS.override.md", "MINE-ROOT\n");
	writeFile("repo/apps/web/AGENTS.md", "TEAM-WEB\n");
	writeFile("repo/apps/web/CLAUDE.md", "TEAM-WEB-CLAUDE\n");
	writeFile("repo/apps/web/AGENTS.override.md", "MINE-WEB\n");
	writeFile("repo/apps/web/CONTEXT.md", "WEB-CONTEXT\n");
	writeFile("repo/apps/mobile/AGENTS.md", "TEAM-MOBILE\n");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("rules builtin with AGENTS.override.md", () => {
	it("loads the root override instead of the root AGENTS.md for the static block", () => {
		const loaded = createRealEngine().loadStaticRules(join(root, "repo"));

		expect(bodies(loaded.rules)).toEqual(["MINE-ROOT"]);
	});

	it("does not inject the shadowed root AGENTS.md when the native loader already read the override", async () => {
		const cwd = join(root, "repo");
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const host = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerFlag: () => {},
			getFlag: (name: string) => (name === "pi-rules-mode" ? "both" : false),
			registerCommand: () => {},
			registerEntryRenderer: () => {},
			appendEntry: () => {},
		};
		piRulesExtension(host as unknown as ExtensionAPI);
		const ctx = { cwd, hasUI: false, ui: { notify: () => {} } };
		const emit = async (event: string, payload: unknown) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
			return result;
		};

		await emit("session_start", { type: "session_start", reason: "startup" });
		const result = (await emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "BASE",
			systemPromptOptions: {
				cwd,
				contextFiles: [{ path: join(cwd, "AGENTS.override.md"), content: "MINE-ROOT\n" }],
			},
		})) as { systemPrompt?: string } | undefined;

		expect(result?.systemPrompt ?? "BASE").not.toContain("TEAM-ROOT");
	});

	it("injects the directory override instead of its AGENTS.md and CLAUDE.md on a nested read", () => {
		const target = writeFile("repo/apps/web/src/a.ts", "export {};\n");

		const loaded = createRealEngine().loadDynamicRules(join(root, "repo"), [target]);

		expect(bodies(loaded.rules)).toEqual(["MINE-WEB", "WEB-CONTEXT", "MINE-ROOT"]);
	});

	it("keeps AGENTS.md in directories without an override", () => {
		const target = writeFile("repo/apps/mobile/src/b.ts", "export {};\n");

		const loaded = createRealEngine().loadDynamicRules(join(root, "repo"), [target]);

		expect(bodies(loaded.rules)).toEqual(["TEAM-MOBILE", "MINE-ROOT"]);
	});
});

describe("nested-agents-md builtin with AGENTS.override.md", () => {
	it("injects the directory override instead of its AGENTS.md", async () => {
		const target = writeFile("repo/apps/web/src/a.ts", "export {};\n");

		const result = await injectDirectoryContext({
			filePath: target,
			rootDir: join(root, "repo"),
			cache: new InjectionCache(),
			sessionKey: "session",
		});

		expect(result.injectedFiles.map((file) => file.absolutePath)).toEqual([
			join(root, "repo/apps/web/AGENTS.override.md"),
		]);
		expect(result.injectedText).toContain("MINE-WEB");
		expect(result.injectedText).not.toContain("TEAM-WEB");
	});

	it("keeps AGENTS.md in directories without an override", async () => {
		const target = writeFile("repo/apps/mobile/src/b.ts", "export {};\n");

		const result = await injectDirectoryContext({
			filePath: target,
			rootDir: join(root, "repo"),
			cache: new InjectionCache(),
			sessionKey: "session",
		});

		expect(result.injectedFiles.map((file) => file.absolutePath)).toEqual([join(root, "repo/apps/mobile/AGENTS.md")]);
	});
});
