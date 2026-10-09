import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { availability, session, textOf } from "./load-cell-session.ts";

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
