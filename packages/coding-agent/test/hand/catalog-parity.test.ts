import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { type CliRuntimeConfiguration, createCliRuntimeFactory } from "../../src/main.ts";
import { handToolCatalog, type ToolDeclaration, toolCatalog } from "../../src/modes/hand/tool-catalog.ts";
import { createLooplessRuntimeFactory } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixtureExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echoes its value.",
		promptSnippet: "echo: repeat a value",
		promptGuidelines: ["Use echo only to repeat a value."],
		annotations: { readOnlyHint: true },
		parameters: Type.Object({ value: Type.Number(), note: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: String(params.value) }], details: {} };
		},
	});
	pi.registerTool({
		name: "find_widget",
		label: "Find widget",
		description: "Looks up a widget by id.",
		parameters: Type.Object({ id: Type.String() }),
		exposure: "search",
		searchText: "widget lookup by identifier",
		searchKeywords: ["widget", "lookup"],
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: params.id }], details: {} };
		},
	});
}

interface ParityCase {
	readonly name: string;
	readonly flags: readonly string[];
	readonly settings?: Record<string, unknown>;
	readonly expectTools: readonly string[];
	readonly expectAbsent: readonly string[];
	/** The filter must remove at least one tool the unfiltered fused session registers, and keep these. */
	readonly narrowsUnfilteredKeeping?: readonly string[];
}

const BASE_FLAGS = ["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"] as const;

const DEFAULT_TOOLS = ["read", "echo"] as const;

const CASES: readonly ParityCase[] = [
	{ name: "no tool filter", flags: [], expectTools: ["read", "bash", "echo", "find_widget"], expectAbsent: [] },
	{
		name: "--tools",
		flags: ["--tools", "read,echo"],
		expectTools: ["read", "echo"],
		expectAbsent: ["bash", "find_widget"],
	},
	{
		name: "--exclude-tools",
		flags: ["--exclude-tools", "bash,find_widget"],
		expectTools: ["read", "echo"],
		expectAbsent: ["bash", "find_widget"],
	},
	{
		name: "--no-tools",
		flags: ["--no-tools"],
		expectTools: [],
		expectAbsent: ["read", "bash", "echo", "find_widget"],
	},
	{
		name: "--no-builtin-tools (narrows only the active set; the catalog is unchanged)",
		flags: ["--no-builtin-tools"],
		expectTools: ["read", "bash", "echo", "find_widget"],
		expectAbsent: [],
	},
	{
		name: "settings defaultTools",
		flags: [],
		settings: { defaultTools: DEFAULT_TOOLS },
		expectTools: ["read", "bash", "echo", "find_widget"],
		expectAbsent: [],
		narrowsUnfilteredKeeping: DEFAULT_TOOLS,
	},
];

const extensionFactories: InlineExtension[] = [...builtInExtensions, fixtureExtension];

async function scratchDirs(settings: Record<string, unknown> | undefined) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-hand-catalog-"));
	cleanups.push(() => rm(scratch, { recursive: true, force: true }));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	if (settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
	return { cwd, agentDir };
}

async function fusedCatalogFor(configuration: CliRuntimeConfiguration) {
	const { cwd, agentDir } = configuration;
	const fused = await createCliRuntimeFactory(configuration, { extensionFactories })({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	cleanups.push(async () => {
		fused.session.dispose();
		await fused.session.whenToolChildClosed();
	});
	return toolCatalog(fused.session.getAllTools().flatMap((tool) => fused.session.getToolDefinition(tool.name) ?? []));
}

function names(catalog: readonly ToolDeclaration[]): string[] {
	return catalog.map((tool) => tool.name);
}

describe("a hand exposes the same tool catalog as the fused engine for the same configuration", () => {
	it.each(CASES)(
		"$name",
		async ({ flags, settings, expectTools, expectAbsent, narrowsUnfilteredKeeping }) => {
			const { cwd, agentDir } = await scratchDirs(settings);
			const configuration = { parsed: parseArgs([...BASE_FLAGS, ...flags]), cwd, agentDir, appMode: "rpc" as const };
			const fusedCatalog = await fusedCatalogFor(configuration);
			const hand = await createLooplessRuntimeFactory(configuration, { extensionFactories })({ cwd });
			cleanups.push(() => hand.dispose());
			const handCatalog = handToolCatalog(hand.definitions);

			const fusedNames = names(fusedCatalog);
			expect(fusedNames).toEqual(expect.arrayContaining([...expectTools]));
			for (const absent of expectAbsent) expect(fusedNames).not.toContain(absent);
			if (narrowsUnfilteredKeeping) {
				const unfiltered = await scratchDirs(undefined);
				const unfilteredNames = names(
					await fusedCatalogFor({ ...configuration, parsed: parseArgs([...BASE_FLAGS]), ...unfiltered }),
				);
				const removed = unfilteredNames.filter((name) => !fusedNames.includes(name));
				expect(removed.length).toBeGreaterThan(0);
				expect(removed.filter((name) => narrowsUnfilteredKeeping.includes(name))).toEqual([]);
			}

			expect(names(handCatalog)).toEqual(fusedNames);
			handCatalog.forEach((declaration, index) => {
				expect(JSON.parse(JSON.stringify(declaration)), declaration.name).toEqual(
					JSON.parse(JSON.stringify(fusedCatalog[index])),
				);
			});
		},
		60_000,
	);
});
