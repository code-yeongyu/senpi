import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createMovedLayout, type MovedLayout, runTool } from "./moved-path-guard-fixtures.ts";

/**
 * code-yeongyu/senpi#2898: tools that do not consult the filesystem policy (apply_patch, the shell tools,
 * generate_image) are refused by the guard's blocking `tool_call` handler when they name a moved path,
 * including calls a codemode script makes through `ctx.executeTool()`.
 */

function builtin(id: string): ExtensionFactory {
	const entry = builtinExtensions.find((extension) => extension.id === id);
	if (!entry) throw new Error(`missing builtin extension: ${id}`);
	return entry.factory;
}

/** Stands in for a codemode cell: it issues nested calls through the same API codemode uses. */
function nestedCaller(calls: ReadonlyArray<readonly [string, Record<string, unknown>]>) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "run_nested",
			label: "run_nested",
			description: "Runs nested tool calls.",
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				const texts: string[] = [];
				for (const [name, args] of calls) {
					try {
						const outcome = await ctx.executeTool(name, args);
						texts.push(`${name}: ${JSON.stringify(outcome.result.content)}`);
					} catch (error) {
						texts.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				return { content: [{ type: "text", text: texts.join("\n") }], details: {} };
			},
		});
	};
}

describe("moved-path-guard: commands, patches, and nested calls (#2898)", () => {
	const layouts: MovedLayout[] = [];
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (layouts.length > 0) layouts.pop()?.cleanup();
	});

	async function setup(
		options: { builtins?: string[]; cwd?: (layout: MovedLayout) => string; breadcrumb?: boolean } = {},
	) {
		const layout = createMovedLayout({ breadcrumb: options.breadcrumb });
		layouts.push(layout);
		vi.stubEnv("HOME", layout.home);
		vi.stubEnv("USERPROFILE", layout.home);
		const harness = await createHarness({
			cwd: options.cwd?.(layout) ?? layout.home,
			extensionFactories: ["moved-path-guard", ...(options.builtins ?? [])].map(builtin),
			initialActiveToolNames: [
				"bash",
				"bash_input",
				"monitor",
				"powershell",
				"apply_patch",
				"generate_image",
				"write",
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { layout, harness };
	}

	const forms: ReadonlyArray<readonly [string, (layout: MovedLayout) => string]> = [
		["absolute", (layout) => `mkdir -p ${layout.oldWorktree}/src`],
		["~", () => "mkdir -p ~/.t3/worktrees/app/w1/src && echo ok"],
		["$HOME", () => 'touch "$HOME/.t3/userdata/omo-sessions/x.jsonl"'],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell text the guard must read.
		["${HOME}", () => "cd ${HOME}/.t3/worktrees/app/w1; ls"],
		["%USERPROFILE%", () => "echo hi > %USERPROFILE%\\.t3\\worktrees\\app\\w1\\a.txt"],
	];
	const shellTools: ReadonlyArray<readonly [string, (command: string) => Record<string, unknown>]> = [
		["bash", (command) => ({ command })],
		["bash_input", (command) => ({ bash_id: "b1", input: command })],
		["monitor", (command) => ({ command, description: "watch" })],
		["powershell", (command) => ({ command })],
	];

	it.each(shellTools.flatMap(([tool, args]) => forms.map(([form, command]) => [tool, form, args, command] as const)))(
		"blocks %s naming a moved prefix in %s form",
		async (tool, _form, args, command) => {
			const { layout, harness } = await setup({ builtins: ["terminal"] });

			const result = await runTool(harness, tool, args(command(layout)));

			expect(result.outcome).toBe("blocked");
			expect(result.text).toContain(`This folder moved to ${layout.newRoot}.`);
			expect(existsSync(layout.oldWorktree)).toBe(false);
		},
	);

	// Review H2: paths written out inside inline code, glued to a flag, or split by shell quoting.
	const embedded: ReadonlyArray<readonly [string, (layout: MovedLayout) => string]> = [
		["python -c", (layout) => `python3 -c "open('${layout.oldWorktree}/x','w').write('a')"`],
		["node -e", (layout) => `node -e 'require("fs").writeFileSync("${layout.oldWorktree}/x","a")'`],
		["tar -C<path>", (layout) => `tar -C${layout.oldWorktree} -xf a.tar`],
		['"$HOME"/…', () => 'mkdir -p "$HOME"/.t3/worktrees/app/w1/x'],
		['$HOME/".t3"/…', () => 'mkdir -p $HOME/".t3"/worktrees/app/w1/x'],
		["--flag=~/…", () => "rsync -a src/ --target=~/.t3/worktrees/app/w1"],
		// Re-review L5: clustered short flags and curl-style @file arguments.
		["tar -xf<path>", (layout) => `tar -xf${layout.oldWorktree}/a.tar`],
		["curl -d @<path>", (layout) => `curl -d @${layout.oldWorktree}/body.json https://example.invalid`],
	];

	it.each(embedded)("blocks a moved path embedded in %s", async (_form, command) => {
		const { layout, harness } = await setup();

		const result = await runTool(harness, "bash", { command: command(layout) });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(layout.newWorktree);
	});

	// Review M2: a relative path after `cd <dir>` in the same text names <dir>/<path>. bash_input has no tracked shell
	// cwd the guard can see, so for it only a `cd` inside the same input counts.
	it.each([
		["bash", { command: "cd ~/.t3 && mkdir -p worktrees/app/w1/x" }],
		["bash", { command: 'cd "$HOME/.t3"; touch userdata/omo-sessions/a.jsonl' }],
		["bash_input", { bash_id: "b1", input: "cd ~/.t3 && mkdir -p worktrees/app/w1/x" }],
	] as const)("blocks %s naming a moved path relative to an earlier cd", async (tool, input) => {
		const { layout, harness } = await setup({ builtins: ["terminal"] });

		const result = await runTool(harness, tool, { ...input });

		expect(result.outcome).toBe("blocked");
		expect(result.text).toContain(layout.newRoot);
	});

	it("resolves relative paths against the directory a cd moved to, not the moved root", async () => {
		const { layout, harness } = await setup();
		mkdirSync(join(layout.home, "elsewhere"), { recursive: true });

		const result = await runTool(harness, "bash", { command: "cd elsewhere && mkdir -p worktrees/app/w1/x" });

		expect(result).toMatchObject({ outcome: "ok" });
		expect(existsSync(join(layout.home, "elsewhere", "worktrees", "app", "w1", "x"))).toBe(true);
	});

	it("blocks a shell call whose working directory is a moved path", async () => {
		const { layout, harness } = await setup({ cwd: (moved) => moved.oldWorktree });

		const result = await runTool(harness, "bash", { command: "ls" });

		expect(result).toMatchObject({ outcome: "blocked" });
		expect(result.text).toContain(layout.newWorktree);
	});

	it("blocks apply_patch when one of its targets is moved", async () => {
		const { layout, harness } = await setup({ builtins: ["gpt-apply-patch"] });
		const patch = [
			"*** Begin Patch",
			"*** Add File: fine.txt",
			"+fine",
			`*** Add File: ${join(layout.oldWorktree, "b.txt")}`,
			"+moved",
			"*** End Patch",
		].join("\n");
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "apply_patch"]);

		const result = await runTool(harness, "apply_patch", { input: patch });

		expect(result).toMatchObject({ outcome: "blocked" });
		expect(result.text).toContain(join(layout.newWorktree, "b.txt"));
		expect(existsSync(join(layout.home, "fine.txt"))).toBe(false);
	});

	it("blocks generate_image writing its output into a moved prefix", async () => {
		const { layout, harness } = await setup({ builtins: ["imagegen"] });

		const result = await runTool(harness, "generate_image", {
			prompt: "a cat",
			output_path: join(layout.oldWorktree, "cat.png"),
		});

		expect(result).toMatchObject({ outcome: "blocked" });
		expect(result.text).toContain(join(layout.newWorktree, "cat.png"));
	});

	it("blocks nested codemode write and bash calls", async () => {
		const layout = createMovedLayout();
		layouts.push(layout);
		const calls = [
			["write", { path: join(layout.oldSessions, "s.jsonl"), content: "x" }],
			["bash", { command: `mkdir -p ${layout.oldWorktree}` }],
		] as const;
		const harness = await createHarness({
			cwd: layout.home,
			extensionFactories: [builtin("moved-path-guard"), nestedCaller(calls)],
			initialActiveToolNames: ["write", "bash", "run_nested"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("run_nested", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		const text = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
		expect(text).toContain(join(layout.newSessions, "s.jsonl"));
		expect(text).toContain(
			`bash: [{"type":"text","text":"This folder moved to ${layout.newRoot}. Use ${layout.newWorktree}.`,
		);
		expect(existsSync(layout.oldSessions)).toBe(false);
		expect(existsSync(layout.oldWorktree)).toBe(false);
	});

	it("runs shell calls that name a reused T3 Code worktree, an unlisted path, or anything without a breadcrumb", async () => {
		const { layout, harness } = await setup();
		mkdirSync(layout.oldWorktree, { recursive: true });
		writeFileSync(join(layout.oldWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/w1\n");

		const reused = await runTool(harness, "bash", { command: `touch ${join(layout.oldWorktree, "t3.txt")}` });
		const unlisted = await runTool(harness, "bash", {
			command: `mkdir -p ${join(layout.oldRoot, "userdata")} && touch ${join(layout.oldRoot, "userdata", "statev2.sqlite")}`,
		});

		expect(reused).toMatchObject({ outcome: "ok" });
		expect(existsSync(join(layout.oldWorktree, "t3.txt"))).toBe(true);
		expect(unlisted).toMatchObject({ outcome: "ok" });

		const bare = await setup({ breadcrumb: false });
		expect(await runTool(bare.harness, "bash", { command: `mkdir -p ${bare.layout.oldWorktree}` })).toMatchObject({
			outcome: "ok",
		});
		expect(existsSync(bare.layout.oldWorktree)).toBe(true);
	});
});
