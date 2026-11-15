// senpi#6749 (S-CAT): a hosted loop learns the tool list a local session on the hand's machine would show its model,
// through the hand's `describe_tools` loop hook. The oracle is a real local session on the same cwd, flags and settings:
// its active tools, its eval-only routing (the redirect hints it publishes for withheld tools), its definitions and its
// prompt resources. Nothing is left out: the tools that need the session's record run on the hand too, marked
// `sessionBound` so the loop's calls carry its read half (architecture contract of the hosted parity design v4: the
// loop registers no tool of its own).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { type ToolDeclaration, toolCatalog } from "../../src/modes/hand/tool-catalog.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { expectedOnHand } from "./catalog-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const echoTool = (name: string, extra: object = {}) => ({
	name,
	label: name,
	description: `The ${name} probe.`,
	parameters: Type.Object({ value: Type.String() }),
	...extra,
	async execute() {
		return { content: [{ type: "text" as const, text: name }], details: {} };
	},
});

/** Declares its own tools beside the builtins' `eval` (codemode), which arms the eval-only routing. */
function evalExtension(pi: ExtensionAPI): void {
	pi.registerTool(
		echoTool("echo", { promptSnippet: "echo: repeat a value", promptGuidelines: ["Use echo only to repeat."] }),
	);
	pi.registerTool(echoTool("probe_eval_only", { exposure: "eval" }));
	// A tool declared for the loop's side of a split session still works on the hand, so it is advertised.
	pi.registerTool(echoTool("loop_side_probe", { runs: "brain" }));
}

function plainExtension(pi: ExtensionAPI): void {
	pi.registerTool(echoTool("echo"));
}

interface Case {
	readonly name: string;
	readonly extension: (pi: ExtensionAPI) => void;
	readonly flags: readonly string[];
	readonly settings?: Record<string, unknown>;
	readonly armed: boolean;
}

const CASES: readonly Case[] = [
	{ name: "eval-only routing armed", extension: evalExtension, flags: [], armed: true },
	{
		name: "eval excluded (routing disarmed)",
		extension: plainExtension,
		flags: ["--exclude-tools", "eval"],
		armed: false,
	},
	{
		name: "settings defaultTools with eval armed",
		extension: evalExtension,
		flags: [],
		settings: { defaultTools: ["read", "edit", "bash", "eval", "todo"] },
		armed: true,
	},
	{ name: "--no-builtin-tools", extension: evalExtension, flags: ["--no-builtin-tools"], armed: true },
	{
		name: "--tools",
		extension: evalExtension,
		flags: ["--tools", "read,bash,eval,echo,todo,loop_side_probe"],
		armed: true,
	},
];

interface DescribeToolsReply {
	readonly tools: readonly ToolDeclaration[];
	readonly active: readonly string[];
	readonly evalOnly: readonly string[];
	readonly context: { readonly contextFiles: readonly unknown[]; readonly skills: readonly unknown[] };
}

async function scratch(settings: Record<string, unknown> | undefined) {
	const root = await mkdtemp(join(tmpdir(), "senpi-describe-tools-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(agentDir, "skills", "probe-skill"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "AGENTS.md"), "# Project rules\n\nUse tabs.\n");
	await writeFile(
		join(agentDir, "skills", "probe-skill", "SKILL.md"),
		"---\nname: probe-skill\ndescription: Probes the skill list.\n---\n\nBody.\n",
	);
	if (settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	return { cwd, agentDir };
}

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("describe_tools answers the tool list a local session on the hand's machine shows its model", () => {
	it.each(CASES)(
		"$name",
		async ({ extension, flags, settings, armed }) => {
			const { cwd, agentDir } = await scratch(settings);
			const configuration = {
				parsed: parseArgs(["--mode", "rpc", "--no-prompt-templates", ...flags]),
				cwd,
				agentDir,
				appMode: "rpc" as const,
			};
			const extensionFactories: InlineExtension[] = [extension];
			const { session } = await createCliRuntimeFactory(configuration, { extensionFactories })({
				cwd,
				agentDir,
				sessionManager: SessionManager.inMemory(cwd),
			});
			cleanups.push(async () => {
				session.dispose();
				await session.whenToolChildClosed();
			});
			const hand = createLooplessHand(configuration, { extensionFactories, twoSidedHome: "hand" });
			cleanups.push(() => hand.close());

			const reply = (await hand.loopHooks("describe_tools", {
				sessionId: "describe-tools-session",
				idle: true,
				scope: { id: "describe-tools-scope", root: cwd },
			})) as unknown as DescribeToolsReply;

			const sessionTools = session.getAllTools().map((tool) => tool.name);
			expect(reply.tools.map((tool) => tool.name)).toEqual(sessionTools);
			const sessionCatalog = toolCatalog(sessionTools.flatMap((name) => session.getToolDefinition(name) ?? []));
			reply.tools.forEach((declaration, index) => {
				const fused = sessionCatalog[index];
				if (fused === undefined) throw new Error(`no session declaration at ${index}`);
				expect(declaration, declaration.name).toEqual(plain(expectedOnHand(fused, declaration)));
			});

			// The wire flag is the definition's own; which tools declare it is pinned by session-bound-rule.test.ts.
			for (const declaration of reply.tools)
				expect(declaration.sessionBound, declaration.name).toBe(
					session.getToolDefinition(declaration.name)?.sessionBound === true,
				);
			expect(reply.tools.find((tool) => tool.name === "todo")?.sessionBound).toBe(true);

			expect(reply.active).toEqual(session.getActiveToolNames());
			// The session's own eval-only redirects, not the hints other publishers (tool search, extensions) add.
			const withheld = Object.entries(session.agent.removedToolHints)
				.filter(([name, hint]) => hint.startsWith(`Run ${name} inside an eval cell`))
				.map(([name]) => name);
			expect(withheld.length > 0).toBe(armed);
			expect([...reply.evalOnly].sort()).toEqual(withheld.sort());
			if (armed) expect(reply.evalOnly).toContain("bash");
			if (extension === evalExtension) expect(reply.tools.map((tool) => tool.name)).toContain("loop_side_probe");

			const resources = session.resourceLoader;
			expect(reply.context.contextFiles).toEqual(plain(resources.getAgentsFiles().agentsFiles));
			expect(reply.context.skills).toEqual(plain(resources.getSkills().skills));
			expect(JSON.stringify(reply.context.contextFiles)).toContain("Use tabs.");
			expect(JSON.stringify(reply.context.skills)).toContain("probe-skill");
		},
		60_000,
	);
});
