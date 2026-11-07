import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../src/interpreters/detect.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalLanguage, EvalToolDetails } from "../src/tool/types.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

const settings = { ...defaultCodemodeSettings, languages: { js: true, py: true, rb: true, jl: true } };
const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
const cleanups: Array<() => Promise<void>> = [];
const TICKS = 3;
const UPDATE_DEADLINE_MS = 20_000;

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type CellUpdate = { readonly text: string; readonly cellOutput: string | undefined };
type ToolOptions = { readonly onUpdate?: AgentToolUpdateCallback<unknown> };

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function partial(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

function ticksUpTo(count: number): string {
	return Array.from({ length: count }, (_, index) => `tick-${index + 1}\n`).join("");
}

/**
 * A host whose `ticker` tool streams the way the bash tool does: an empty first update, then the cumulative output
 * after each tick. Tick N+1 is held until the test saw tick N on the cell's live update, so every partial has a gap
 * and the tool cannot return before all of them were observed.
 */
async function session() {
	const root = await mkdtemp(join(tmpdir(), "senpi-nested-tool-updates-"));
	const updates: CellUpdate[] = [];
	const waiters: Array<{ readonly needle: string; readonly resolve: () => void }> = [];
	const steps = Array.from({ length: TICKS }, () => Promise.withResolvers<void>());
	let returned = false;
	const executeTool = async (toolName: string, _args: unknown, options?: ToolOptions) => {
		if (toolName !== "ticker") throw new Error(`unexpected tool ${toolName}`);
		options?.onUpdate?.({ content: [], details: undefined });
		for (let tick = 1; tick <= TICKS; tick++) {
			options?.onUpdate?.(partial(ticksUpTo(tick)));
			await steps[tick - 1]?.promise;
		}
		returned = true;
		return partial("ticker done");
	};
	const manager = await createCodemodeSessionManager({
		sessionId: `nested-tool-updates-${crypto.randomUUID()}`,
		cwd: root,
		settings,
		availability,
		executeTool,
		complete: async () => {
			throw new Error("no provider calls in this test");
		},
	});
	const tool = createEvalTool({
		enabledLanguages: settings.languages,
		kernelManager: manager,
		executeTool,
		cellTimeoutSeconds: 120,
	});
	cleanups.push(async () => {
		for (const step of steps) step.resolve();
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const onUpdate = (update: AgentToolResult<EvalToolDetails>) => {
		const text = textOf(update);
		updates.push({ text, cellOutput: update.details.cells?.[0]?.output });
		for (const waiter of waiters.splice(0)) {
			if (text.includes(waiter.needle)) waiter.resolve();
			else waiters.push(waiter);
		}
	};
	const sawLive = async (needle: string): Promise<void> => {
		if (updates.some((update) => update.text.includes(needle))) return;
		const seen = Promise.withResolvers<void>();
		waiters.push({ needle, resolve: seen.resolve });
		const timer = setTimeout(
			() => seen.reject(new Error(`no live cell update carried ${JSON.stringify(needle)}`)),
			UPDATE_DEADLINE_MS,
		);
		try {
			await seen.promise;
		} finally {
			clearTimeout(timer);
		}
	};
	const context = { ...fakeExtensionContext(), cwd: root };
	const run = (language: EvalLanguage, code: string) =>
		tool.execute(
			`nested-${language}-${crypto.randomUUID()}`,
			{ language, code, summary: "Stream a nested tool" },
			undefined,
			onUpdate,
			context,
		);
	return { run, updates, steps, sawLive, wasReturned: () => returned };
}

const CELLS: Record<EvalLanguage, string> = {
	js: "const r = await tool.ticker({});\nprint(r.text)",
	py: "print(tool.ticker()['text'])",
	rb: 'puts tool.ticker({})["text"]',
	jl: 'println(tool.ticker(Dict())["text"])',
};

describe("Given a cell that awaits a nested tool streaming partial results (#6167)", () => {
	for (const language of ["js", "py", "rb", "jl"] as const) {
		it.skipIf(!availability[language].detected.ok)(
			`When the ${language} cell runs it, then each partial reaches the cell's live update before the tool returns, and the result is unchanged`,
			async () => {
				const { run, updates, steps, sawLive, wasReturned } = await session();

				const result = run(language, CELLS[language]);
				const settledEarly = result.then((settled) => {
					throw new Error(`the cell settled before every tick streamed: ${textOf(settled)}`);
				});
				settledEarly.catch(() => undefined);
				for (let tick = 1; tick <= TICKS; tick++) {
					await Promise.race([sawLive(`tick-${tick}`), settledEarly]);
					expect(wasReturned()).toBe(false);
					const live = updates.findLast((update) => update.text.includes(`tick-${tick}`));
					expect(live?.cellOutput).toContain(ticksUpTo(tick));
					steps[tick - 1]?.resolve();
				}
				const settled = await result;

				expect(textOf(settled).trimEnd()).toBe("ticker done");
				expect(settled.details.cells?.[0]?.output).not.toContain("tick-");
				const ticksSeen = new Set(updates.flatMap((update) => update.text.match(/tick-\d/g) ?? []));
				expect([...ticksSeen].sort()).toEqual(["tick-1", "tick-2", "tick-3"]);
			},
			120_000,
		);
	}
});
