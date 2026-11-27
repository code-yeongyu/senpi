import { afterEach, describe, expect, it, vi } from "vitest";
import { type Args, parseArgs } from "../../src/cli/args.ts";
import { launchArgv, setupArgv } from "../../src/engine/launch-argv.ts";
import type { LaunchMode, LaunchOptions } from "../../src/engine/launch-options.ts";

type Tree = { [key: string]: unknown };

/** Drops undefined fields and objects left empty, so a decoded value compares to the options as given. */
function pruned(value: unknown): unknown {
	if (Array.isArray(value) || typeof value !== "object" || value === null) return value;
	const entries = Object.entries(value as Tree)
		.map(([key, field]) => [key, pruned(field)] as const)
		.filter(
			([, field]) =>
				field !== undefined &&
				!(typeof field === "object" && field !== null && !Array.isArray(field) && Object.keys(field).length === 0),
		);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** The independent reading of the parser's `Args` back into launch options: the oracle of the round trip. */
function decoded(args: Args): unknown {
	return pruned({
		session: {
			continue: args.continue,
			path: args.session,
			id: args.sessionId,
			fork: args.fork,
			rebind: args.rebind,
			ephemeral: args.noSession,
			dir: args.sessionDir,
			spawned_by: args.spawnedBy,
			name: args.name,
		},
		setup: {
			model: args.model,
			provider: args.provider,
			model_patterns: args.models,
			reasoning: args.thinking,
			system_prompt: args.systemPrompt,
			append_system_prompt: args.appendSystemPrompt,
			tools: { allow: args.tools, deny: args.excludeTools, none: args.noTools, no_builtin: args.noBuiltinTools },
			extensions: { paths: args.extensions, none: args.noExtensions },
			skills: { names: args.skills, none: args.noSkills },
			prompt_templates: { paths: args.promptTemplates, none: args.noPromptTemplates },
			themes: { paths: args.themes, none: args.noThemes, use: args.useTheme },
			context_files: args.noContextFiles === true ? false : undefined,
			project_trust: args.projectTrustOverride,
			offline: args.offline,
			session_runtime: args.sessionRuntime,
			tool_runtime: args.toolRuntime,
			auto_title: args.autoTitleSessions,
			extension_flags: args.unknownFlags.size > 0 ? Object.fromEntries(args.unknownFlags) : undefined,
		},
		input: {
			messages: args.messages.length > 0 ? args.messages : undefined,
			files: args.fileArgs.length > 0 ? args.fileArgs : undefined,
			stdin: args.readStdin,
		},
		gated: { grok_neo: args.grokNeo },
		presenter:
			args.presenterBootstrapFd === undefined
				? undefined
				: { bootstrap_fd: args.presenterBootstrapFd, enforcement: args.mcpPresenterEnforcement },
		tui_mode: args.tuiMode,
		verbose: args.verbose,
		attach: args.attach === undefined ? undefined : { socket: args.attach, session: args.session },
		mode: args.print === true ? args.mode : undefined,
		listen: args.listen,
		multi_session: args.listen === undefined ? args.multiSession : undefined,
	});
}

function roundTrip(mode: LaunchMode, options: LaunchOptions): unknown {
	const args = parseArgs(launchArgv(mode, options));
	expect(args.diagnostics).toEqual([]);
	const value = decoded(args);
	if (options.attach === undefined || typeof value !== "object" || value === null) return value;
	const { session: _session, ...rest } = value as Tree;
	return rest;
}

afterEach(() => vi.unstubAllEnvs());

const PRINT_CASES: ReadonlyArray<readonly [string, LaunchOptions]> = [
	["session.continue", { session: { continue: true } }],
	["session.path", { session: { path: "/tmp/s.jsonl" } }],
	["session.id", { session: { id: "abc-123" } }],
	["session.fork", { session: { fork: "abc" } }],
	["session.rebind", { session: { rebind: "abc" } }],
	["session.ephemeral", { session: { ephemeral: true } }],
	["session.dir", { session: { dir: "/tmp/sessions" } }],
	["session.spawned_by", { session: { spawned_by: { parentSessionId: "p", rootSessionId: "r", taskId: "t" } } }],
	["session.name", { session: { name: "a name" } }],
	["setup.model", { setup: { model: "m" } }],
	["setup.provider", { setup: { provider: "acme", model: "m" } }],
	["setup.model_patterns", { setup: { model_patterns: ["a/*", "b"] } }],
	["setup.reasoning", { setup: { reasoning: "high" } }],
	["setup.system_prompt", { setup: { system_prompt: "be brief" } }],
	["setup.append_system_prompt", { setup: { append_system_prompt: ["one", "two"] } }],
	["setup.tools.allow", { setup: { tools: { allow: ["read", "bash"] } } }],
	["setup.tools.deny", { setup: { tools: { deny: ["write"] } } }],
	["setup.tools.none", { setup: { tools: { none: true } } }],
	["setup.tools.no_builtin", { setup: { tools: { no_builtin: true } } }],
	["setup.extensions.paths", { setup: { extensions: { paths: ["builtin:a", "./b.ts"] } } }],
	["setup.extensions.none", { setup: { extensions: { none: true } } }],
	["setup.skills.names", { setup: { skills: { names: ["s1", "s2"] } } }],
	["setup.skills.none", { setup: { skills: { none: true } } }],
	["setup.prompt_templates.paths", { setup: { prompt_templates: { paths: ["t"] } } }],
	["setup.prompt_templates.none", { setup: { prompt_templates: { none: true } } }],
	["setup.themes.paths", { setup: { themes: { paths: ["th"] } } }],
	["setup.themes.none", { setup: { themes: { none: true } } }],
	["setup.themes.use", { setup: { themes: { use: "dark" } } }],
	["setup.context_files", { setup: { context_files: false } }],
	["setup.project_trust true", { setup: { project_trust: true } }],
	["setup.project_trust false", { setup: { project_trust: false } }],
	["setup.offline", { setup: { offline: true } }],
	["setup.session_runtime", { setup: { session_runtime: "worker" } }],
	["setup.tool_runtime", { setup: { tool_runtime: "child" } }],
	["setup.auto_title", { setup: { auto_title: true } }],
	["setup.extension_flags", { setup: { extension_flags: { plan: true, level: "3" } } }],
	["input.messages", { input: { messages: ["- a dash", "--looks-like-a-flag", "two"] } }],
	["input.files", { input: { files: ["a.md", "b.png"] } }],
	["input.stdin", { input: { stdin: true } }],
];

describe("launch options round-trip through the parser, one field at a time (senpi#7451)", () => {
	it.each(PRINT_CASES)("print: %s", (_field, options) => {
		const given: LaunchOptions = { input: { messages: ["x"] }, ...options, mode: "json" };
		expect(roundTrip("print", given)).toEqual(pruned(given));
	});

	it("print: mode text", () => {
		const given: LaunchOptions = { input: { messages: ["x"] }, mode: "text" };
		expect(roundTrip("print", given)).toEqual(pruned(given));
	});

	it("print: gated.grok_neo while its gate is on", () => {
		vi.stubEnv("SENPI_ENABLE_GROK_NEO", "1");
		const given: LaunchOptions = { input: { messages: ["x"] }, gated: { grok_neo: true }, mode: "text" };
		expect(roundTrip("print", given)).toEqual(pruned(given));
	});

	it.each<readonly [string, LaunchOptions]>([
		["tui_mode", { tui_mode: "fullscreen" }],
		["verbose", { verbose: true }],
		["attach", { attach: { socket: "/tmp/h.sock", session: "abc" } }],
	])("interactive: %s", (_field, options) => {
		expect(roundTrip("interactive", options)).toEqual(pruned(options));
	});

	it.each<readonly [string, LaunchOptions]>([
		["listen", { listen: "unix:///tmp/x.sock" }],
		["multi_session", { multi_session: true }],
		["presenter", { presenter: { bootstrap_fd: 4, enforcement: true } }],
	])("rpc: %s", (_field, options) => {
		expect(roundTrip("rpc", options)).toEqual(pruned(options));
	});

	it("hand and headless start on their own endpoint in rpc mode, as the parser sets them", () => {
		expect(parseArgs(launchArgv("hand", {}))).toMatchObject({ hand: true, mode: "rpc" });
		expect(parseArgs(launchArgv("headless", {}))).toMatchObject({ headless: true, mode: "rpc", multiSession: true });
		expect(parseArgs(launchArgv("headless", { listen: "unix://" }))).toMatchObject({ listen: "unix://" });
	});

	it("never puts the launch key on the argv, and context_files true is the parser's default", () => {
		expect(launchArgv("print", { input: { messages: ["x"] }, mode: "text" })).not.toContain("--api-key");
		expect(setupArgv({ context_files: true })).toEqual([]);
	});
});
