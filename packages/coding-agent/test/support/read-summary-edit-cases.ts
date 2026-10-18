import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSummary, jsonSource, privateDir, readerNames, readers, textOutput } from "./read-summary-fixture.ts";

export async function summaryRereadEdit() {
	return privateDir(async (cwd) => {
		const receipts = [];
		for (const name of readerNames)
			for (const ending of ["\n", "\r\n"]) {
				const path = join(cwd, `${name}.json`);
				const original =
					`${JSON.stringify({ values: JSON.parse(jsonSource()), literal: "\u2026" }, null, 2)}\n`.replaceAll(
						"\n",
						ending,
					);
				await writeFile(path, original);
				const tools = readers(cwd);
				const output = textOutput(await tools.read(name, { path }));
				const ranges = assertSummary(output);
				const range = ranges[0];
				const exact = original
					.split("\n")
					.slice(range.offset - 1, range.offset - 1 + range.limit)
					.join("\n");
				const reread = textOutput(await tools.read(name, { path, ...range }));
				assert.equal(reread.slice(0, exact.length), exact);
				assert.equal(reread.slice(exact.length, exact.length + 2), "\n\n");
				const newText = exact.replace("body-", "edited-");
				assert.notEqual(newText, exact);
				await tools.edit(name, { path, edits: [{ oldText: exact, newText }] });
				assert.deepEqual(await readFile(path), Buffer.from(original.replace(exact, newText)));
				const fresh = textOutput(await tools.read(name, { path, ...range }));
				assert.equal(fresh.slice(0, newText.length), newText);
				// A retained source edit must also be visible on a new default read at the same path.
				await tools.edit(name, {
					path,
					edits: [{ oldText: '  "literal": "\u2026"', newText: '  "literal": "real source ellipsis edited"' }],
				});
				assert(textOutput(await tools.read(name, { path })).includes('  "literal": "real source ellipsis edited"'));
				receipts.push({
					reader: name,
					ending: ending === "\n" ? "LF" : "CRLF",
					ranges,
					exactBytes: Buffer.byteLength(exact),
					intendedBytesOnly: true,
					fresh: true,
				});
			}
		return { passed: true, cases: receipts };
	});
}

export async function syntheticEditRefusal() {
	return privateDir(async (cwd) => {
		const receipts = [];
		for (const name of readerNames) {
			const path = join(cwd, `${name}.json`);
			const text = JSON.stringify({ values: JSON.parse(jsonSource()), literal: "\u2026" }, null, 2);
			await writeFile(path, text);
			const tools = readers(cwd);
			const output = textOutput(await tools.read(name, { path }));
			assertSummary(output);
			const lines = output.split("\n");
			const marker = lines.indexOf("\u2026");
			const fabricated = lines.slice(marker - 1, marker + 2).join("\n");
			assert(!text.includes(fabricated));
			await assert.rejects(
				tools.edit(name, { path, edits: [{ oldText: fabricated, newText: "corrupted" }] }),
				/Could not find the exact text/,
			);
			await assert.rejects(
				tools.edit(name, { path, edits: [{ oldText: output, newText: "corrupted" }] }),
				/Could not find the exact text/,
			);
			assert.deepEqual(await readFile(path), Buffer.from(text));
			// U+2026 is legal real source; it is not globally forbidden by the edit tool.
			await tools.edit(name, { path, edits: [{ oldText: '"\u2026"', newText: '"literal"' }] });
			assert.deepEqual(await readFile(path), Buffer.from(text.replace('"\u2026"', '"literal"')));
			receipts.push({
				reader: name,
				fabricatedAnchorRejected: true,
				wholeViewRejected: true,
				literalEditable: true,
			});
		}
		return { passed: true, cases: receipts };
	});
}
