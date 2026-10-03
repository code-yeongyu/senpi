import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../src/interpreters/detect.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalLanguage } from "../src/tool/types.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

const settings = { ...defaultCodemodeSettings, languages: { js: true, py: true, rb: false, jl: false } };
const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function session(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "senpi-load-cell-"));
	for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
	const fail = async () => {
		throw new Error("no host tools or provider calls in this test");
	};
	const manager = await createCodemodeSessionManager({
		sessionId: `load-cell-${crypto.randomUUID()}`,
		cwd: root,
		settings,
		availability,
		executeTool: fail,
		complete: fail,
	});
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: availability.py.detected.ok, rb: false, jl: false },
		kernelManager: manager,
		executeTool: fail,
		cellTimeoutSeconds: 60,
	});
	cleanups.push(async () => {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const stackOf = async (code: string): Promise<string> => {
		const kernel = await manager.getKernel("py", () => {});
		const result = await kernel.run({ cellId: `stack-${crypto.randomUUID()}`, code, timeoutMs: 30_000 });
		return result.ok ? "" : (result.error.stack ?? "");
	};
	const context = { ...fakeExtensionContext(), cwd: root };
	const run = async (language: EvalLanguage, code: string) =>
		await tool.execute(
			`load-${crypto.randomUUID()}`,
			{ language, code, summary: "Run a cell" },
			undefined,
			undefined,
			context,
		);
	return { root, run, stackOf };
}

const helpersPy = 'def f(x):\n    return x * 2\n\ndef boom():\n    raise ValueError("from helpers")\n';

describe.skipIf(!availability.py.detected.ok)("Given a Python file loaded with %load", () => {
	it("When the next cell calls its function, then the definition persists and a traceback names the file and line", async () => {
		const { root, run, stackOf } = await session({ "helpers.py": helpersPy });

		const loaded = await run("py", "%load ./helpers.py");
		const doubled = await run("py", "f(2)");
		const stack = await stackOf("boom()");

		expect(textOf(loaded)).not.toContain("Error");
		expect(textOf(doubled)).toContain("4");
		expect(stack).toContain(`File "${join(root, "helpers.py")}", line 5`);
		expect(stack).toContain("ValueError: from helpers");
	}, 120_000);

	it("When the file imports a sibling module, then it resolves next to the file and __file__ names the file", async () => {
		const { root, run } = await session({
			"sibling.py": "def g():\n    return 'sibling ok'\n",
			"main_file.py": "from sibling import g\nloaded_from = __file__\ng()\n",
		});

		const loaded = await run("py", "%load main_file.py");
		const origin = await run("py", "loaded_from");

		expect(textOf(loaded)).toContain("sibling ok");
		expect(textOf(origin)).toContain(join(root, "main_file.py"));
	}, 120_000);

	it("When the file has top-level await and a trailing expression, then it is awaited and the last value is shown like any cell", async () => {
		const { run } = await session({
			"async_file.py": "import asyncio\nawait asyncio.sleep(0)\nvalue = 21\nvalue * 2\n",
		});

		const loaded = await run("py", "%load ./async_file.py");

		expect(textOf(loaded)).toContain("42");
	}, 120_000);
});

describe("Given a JavaScript file loaded with %load", () => {
	it("When it imports a module relative to itself, then the import resolves from the file's directory and its bindings persist", async () => {
		const { root, run } = await session({});
		await import("node:fs/promises").then(async ({ mkdir }) => await mkdir(join(root, "lib"), { recursive: true }));
		await writeFile(join(root, "lib", "sibling.mjs"), "export const twice = (x) => x * 2;\n");
		await writeFile(
			join(root, "lib", "helpers.mjs"),
			'import { twice } from "./sibling.mjs";\nconst fromHelpers = twice(21);\nfromHelpers;\n',
		);

		const loaded = await run("js", "%load ./lib/helpers.mjs");
		const persisted = await run("js", "fromHelpers + 1");

		expect(textOf(loaded)).toContain("42");
		expect(textOf(persisted)).toContain("43");
	}, 60_000);
});

describe("Given a %load that cannot run a local file", () => {
	it("When it names a remote URL, then the cell is refused without fetching anything", async () => {
		const { run } = await session({});

		const result = await run("js", "%load https://example.invalid/x.js");

		expect(textOf(result)).toContain("does not fetch https:// URLs");
	}, 60_000);

	it("When the file does not exist, then the cell fails with file not found and the path", async () => {
		const { run } = await session({});

		const result = await run("js", "%load ./missing.js");

		expect(textOf(result)).toContain("file not found: ./missing.js");
	}, 60_000);

	it("When %load shares its cell with other code, then the cell is refused with the own-cell teaching error", async () => {
		const { run } = await session({ "helpers.py": helpersPy });

		const result = await run("js", "%load ./helpers.py\n1 + 1");

		expect(textOf(result)).toContain("put %load on its own cell");
	}, 60_000);
});
