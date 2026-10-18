import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import {
	READ_FOLD_SETTINGS,
	type ReadFolder,
	selectedReadFolder,
} from "../../../agent/src/harness/utils/read-folders/index.ts";
import { createSegmentedReadView } from "../../../agent/src/harness/utils/segmented-read-view.ts";
import {
	assertSummary,
	interiorFolder,
	jsonSource,
	privateDir,
	readerNames,
	readers,
	source,
	textOutput,
} from "./read-summary-fixture.ts";

export async function summaryParity() {
	return privateDir(async (cwd) => {
		const text = jsonSource();
		await writeFile(join(cwd, "source.json"), text);
		const tools = readers(cwd);
		assert.deepEqual(tools.coding.parameters, tools.harness.parameters);
		assert.deepEqual(Object.keys(tools.coding.parameters.properties).sort(), ["limit", "offset", "path"]);
		for (const input of [
			{ path: "x" },
			{ path: "x", offset: 1, limit: 4 },
			{ path: "x", offset: 1.5 },
			{ path: "x", limit: 0 },
			{ path: "x", offset: -1 },
			{},
			{ path: 1 },
			{ path: "x", limit: "4" },
		]) {
			assert.equal(Value.Check(tools.coding.parameters, input), Value.Check(tools.harness.parameters, input));
		}
		const view = createSegmentedReadView({
			text,
			parsed: selectedReadFolder.fold({ path: "source.json", text, settings: READ_FOLD_SETTINGS }),
		});
		assert.equal(view.status, "summary");
		if (view.status !== "summary") throw new Error("Fixture must summarize");
		const outputs = await Promise.all(
			readerNames.map(async (name) => {
				const output = textOutput(await tools.read(name, { path: "source.json" }));
				assert.deepEqual(assertSummary(output), view.rendered.footer.rereads);
				assert.equal(output, view.rendered.text);
				return { name, output, segments: view.segments, ranges: view.rendered.elidedRanges };
			}),
		);
		assert.equal(outputs[0].output, outputs[1].output);
		return { passed: true, outputs };
	});
}

export async function fallbackParity() {
	return privateDir(async (cwd) => {
		const text = source(100);
		const long = (lines: number) => Array.from({ length: lines }, (_, i) => `line ${i} ${"x".repeat(8)}`).join("\n");
		const bytes = (size: number) => {
			const base = long(100);
			return base + "x".repeat(size - Buffer.byteLength(base));
		};
		const cases = [
			{ name: "99", text: source(99), path: "x.json", summary: false },
			{ name: "100", text, path: "x.json", summary: true },
			{ name: "offset-1", text, path: "x.json", input: { offset: 1 }, summary: false },
			{ name: "limit", text, path: "x.json", input: { limit: 100 }, summary: false },
			{ name: "limit-0", text, path: "x.json", input: { limit: 0 }, summary: false },
			{ name: "2000", text: long(2000), path: "x.json", summary: true },
			{ name: "2000-terminal-newline", text: `${long(2000)}\n`, path: "x.json", summary: true },
			{ name: "2001", text: long(2001), path: "x.json", summary: false },
			{ name: "51200", text: bytes(51200), path: "x.json", summary: true },
			{ name: "51201", text: bytes(51201), path: "x.json", summary: false },
			{ name: "huge-single-line", text: "x".repeat(60000), path: "x.json", summary: false },
			{ name: "both-thresholds", text: long(3000), path: "x.json", summary: false },
			{ name: "large.txt", text: long(2500), path: "large.txt", summary: false },
			{ name: "binary", text: `${text}\0`, path: "x.json", summary: false },
			// #1685 selects `.js`, so an injected folder is consulted there exactly as it is for `.json`.
			{ name: "js", text, path: "x.js", summary: true },
			...[
				"txt",
				"md",
				"MD",
				"markdown",
				"mdown",
				"mkd",
				"mkdn",
				"mdx",
				"ts",
				"tsx",
				"jsx",
				"py",
				"rs",
				"go",
				"sh",
				"unknown",
			].map((ext) => ({ name: ext, text, path: `x.${ext}`, summary: false })),
			...["AGENTS.md", "AGENTS.override.md", "CLAUDE.MD", "skills/example/SKILL.md", "memory/preference.md"].map(
				(path) => ({ name: path, text, path, summary: false }),
			),
		];
		const receipts = [];
		for (const entry of cases) {
			// One backing file, independent logical names exercise classification without creating unrelated paths.
			const path = join(cwd, entry.path.replaceAll("/", "-"));
			await writeFile(path, entry.text);
			let calls = 0;
			const folder: ReadFolder = {
				...interiorFolder,
				fold: (input) => {
					calls++;
					return interiorFolder.fold(input);
				},
			};
			const tools = readers(cwd, { folder });
			const raw = readers(cwd, {});
			for (const name of readerNames) {
				const input = { path, ...entry.input };
				const actual = await tools.read(name, input);
				if (entry.summary) assertSummary(textOutput(actual));
				else assert.deepEqual(actual, await raw.read(name, input), `${name}:${entry.name}`);
				if (entry.name === "2001" || entry.name === "51201" || entry.name === "both-thresholds") {
					const next = Number(/offset=(\d+)/.exec(textOutput(actual))?.[1]);
					assert(next > 1);
					assert.deepEqual(
						await tools.read(name, { path, offset: next }),
						await raw.read(name, { path, offset: next }),
					);
				}
			}
			assert.equal(calls, entry.summary ? 2 : 0, entry.name);
			receipts.push({
				name: entry.name,
				lines: entry.text.split("\n").length,
				bytes: Buffer.byteLength(entry.text),
				summary: entry.summary,
				folderCalls: calls,
			});
		}
		return { passed: true, cases: receipts };
	});
}

export async function folderFallbacks() {
	return privateDir(async (cwd) => {
		const path = join(cwd, "source.json");
		await writeFile(path, source());
		const options = [
			{},
			{ folder: { ...interiorFolder, fold: () => ({ status: "unsupported", reason: "unsupported_language" }) } },
			{ folder: { ...interiorFolder, fold: () => ({ status: "parse_failure", reason: "fixture" }) } },
			{ folder: { ...interiorFolder, fold: ({ text }) => ({ status: "parsed", text, ranges: [] }) } },
		] satisfies { folder?: ReadFolder }[];
		for (const option of options)
			for (const name of readerNames) {
				assert.deepEqual(
					await readers(cwd, option).read(name, { path }),
					await readers(cwd, {}).read(name, { path }),
				);
			}
		const selected = readers(cwd);
		for (const [file, text] of [
			["x.js", `${source()}\n/* unfinished`],
			["x.json", source()],
			["x.js", Array.from({ length: 100 }, () => "const x = 1;").join("\n")],
		]) {
			await writeFile(join(cwd, file), text);
			for (const name of readerNames)
				assert.deepEqual(
					await selected.read(name, { path: file }),
					await readers(cwd, {}).read(name, { path: file }),
				);
		}
		const error = new Error("folder failure is not parse_failure");
		const throwing = readers(cwd, {
			folder: {
				...interiorFolder,
				fold: () => {
					throw error;
				},
			},
		});
		await writeFile(path, source());
		for (const name of readerNames) {
			await assert.rejects(throwing.read(name, { path }), (cause) => cause === error);
			await assert.rejects(selected.read(name, { path: "missing.ts" }));
			await assert.rejects(selected.read(name, { path, offset: 10000 }));
		}
		return { passed: true, optionalFolder: options.length, malformedAndNoSummary: 3, errorPropagation: readerNames };
	});
}
