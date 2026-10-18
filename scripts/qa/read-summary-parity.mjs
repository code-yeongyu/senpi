#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { repository, sha256, stageReadRuntime } from "./read-summary-build.mjs";
import { startReadSession } from "./read-summary-rpc.mjs";

const text = (result) =>
	result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
const ranges = (output) =>
	[...output.matchAll(/offset=(\d+) limit=(\d+)/g)].map((match) => ({
		offset: Number(match[1]),
		limit: Number(match[2]),
	}));

export function frozenReadFiles(input) {
	const manifest = JSON.parse(readFileSync(join(input, "corpus.json"), "utf8"));
	assert.equal(manifest.wasm_allowed, false);
	assert(manifest.entries.length > 0);
	return manifest.entries.map((entry) => {
		const source = resolve(input, entry.copy);
		assert(!relative(input, source).startsWith(".."));
		assert.equal(sha256(source), entry.sha256, entry.id);
		return {
			id: entry.id,
			path: `${entry.id}-${basename(entry.path)}`,
			sha256: entry.sha256,
			content: readFileSync(source, "utf8"),
			language: entry.language,
		};
	});
}

export async function readSurface(command, directory, files) {
	const fixture = join(directory, "read-summary-provider.mjs");
	const session = startReadSession(command, directory, fixture);
	const records = [];
	try {
		await session.ready();
		for (const file of files) {
			writeFileSync(join(directory, file.path), file.content);
			const full = await session.read([{ id: `${file.id}-default`, args: { path: file.path } }]);
			assert.deepEqual(full.identity.folder, { id: "measured-brace", version: "3" });
			// The surface under test must carry the frozen selection, including its grammar engine (#1685).
			assert.equal(full.identity.selection.languages.json, "heuristic");
			assert.equal(full.identity.selection.languages.js, "wasm");
			assert.equal(full.identity.selection.wasm, true);
			assert.equal(full.identity.parserInitCounters.selectedParserRuntimes, 1);
			const output = text(full.results[0].result);
			const elided = output.split("\n").includes("\u2026") ? ranges(output) : [];
			const requests = [
				{ id: `${file.id}-offset-one`, args: { path: file.path, offset: 1 } },
				{ id: `${file.id}-limit`, args: { path: file.path, limit: 8 } },
				...elided.map((range, index) => ({ id: `${file.id}-elided-${index}`, args: { path: file.path, ...range } })),
			];
			const partial = await session.read(requests);
			assert.deepEqual(partial.identity, full.identity);
			assert.equal(text(partial.results.find((row) => row.id === `${file.id}-offset-one`).result), file.content);
			for (const request of requests.slice(1)) {
				const result = partial.results.find((row) => row.id === request.id);
				const offset = request.args.offset ?? 1;
				assert.equal(
					text(result.result).split("\n").slice(0, request.args.limit).join("\n"),
					file.content
						.split("\n")
						.slice(offset - 1, offset - 1 + request.args.limit)
						.join("\n"),
				);
			}
			records.push({ id: file.id, sha256: file.sha256, full, partial, elided });
		}
		// Reuse the same reader/session after changing bytes; an earlier result cannot own this read.
		const first = files[0];
		const changed = `${first.content}\nconst freshReadSentinel = 73;`;
		writeFileSync(join(directory, first.path), changed);
		const fresh = await session.read([{ id: "fresh-after-change", args: { path: first.path, offset: 1 } }]);
		assert.equal(text(fresh.results[0].result), changed);
		return {
			command: session.command,
			cwd: directory,
			records,
			fresh,
			parserInitCounters: records[0].full.identity.parserInitCounters,
		};
	} finally {
		writeFileSync(join(directory, "rpc-events.json"), `${JSON.stringify(session.events, null, 2)}\n`);
		const exit = await session.close();
		writeFileSync(join(directory, "exit.json"), `${JSON.stringify(exit, null, 2)}\n`);
		assert(
			exit.code === 143 || (process.platform === "win32" && (exit.code === 1 || exit.signal === "SIGTERM")),
			JSON.stringify(exit),
		);
	}
}

export function readSummaryControl() {
	const content = JSON.stringify(Array.from({ length: 20 }, () => Array.from({ length: 12 }, (_, i) => i)), null, 2);
	return {
		id: "positive-control",
		path: "positive-control.json",
		content,
		sha256: createHash("sha256").update(content).digest("hex"),
		language: "json",
	};
}

/**
 * A JavaScript control the dependency-free scan cannot fold: its decorators are not a token the
 * lexer can prove, so only the grammar engine summarizes it. A summary here means the shipped
 * surface really loaded its grammar (#1685).
 */
export function readSummaryGrammarControl() {
	const content = Array.from({ length: 12 }, (_, index) =>
		[
			`@registry.entry("module-${index}")`,
			`class Module${index} {`,
			"  run(input) {",
			"    const first = input.first;",
			"    const second = input.second;",
			"    const third = first + second;",
			"    const fourth = third * 2;",
			"    return fourth;",
			"  }",
			"}",
		].join("\n"),
	).join("\n");
	return {
		id: "grammar-control",
		path: "grammar-control.js",
		content,
		sha256: createHash("sha256").update(content).digest("hex"),
		language: "js",
	};
}

export async function compiledReadParity(directory, binary, input) {
	const files = frozenReadFiles(input);
	// A positive structural control prevents both surfaces silently returning raw from passing.
	files.push(readSummaryControl());
	const sourceDirectory = mkdtempSync(join(directory, "source-runtime-"));
	const binaryDirectory = mkdtempSync(join(directory, "binary-runtime-"));
	const sourceLayout = stageReadRuntime(sourceDirectory);
	const binaryLayout = stageReadRuntime(binaryDirectory, binary);
	assert.equal(existsSync(join(binaryDirectory, "node_modules")), false);
	const source = await readSurface(sourceLayout.command, sourceDirectory, files);
	const compiled = await readSurface(binaryLayout.command, binaryDirectory, files);
	assert.deepEqual(compiled.records, source.records);
	assert.deepEqual(compiled.fresh, source.fresh);
	assert(
		source.records.some((row) => row.elided.length > 0),
		"Actual registered read never summarized",
	);
	// No grammar is selected. Delete only our external decoys, never an installed/reference tree.
	const decoyDirectory = join(binaryDirectory, "external-grammars");
	mkdirSync(decoyDirectory);
	writeFileSync(join(decoyDirectory, "unused.wasm"), "not a grammar");
	const positive = files.at(-1);
	const withDecoy = await readSurface(binaryLayout.command, binaryDirectory, [positive]);
	rmSync(decoyDirectory, { recursive: true });
	const withoutDecoy = await readSurface(binaryLayout.command, binaryDirectory, [positive]);
	assert.deepEqual(withDecoy.records, withoutDecoy.records);
	assert.deepEqual(withDecoy.fresh, withoutDecoy.fresh);
	return {
		corpusManifestSha256: sha256(join(input, "corpus.json")),
		corpusFiles: files.length - 1,
		source,
		compiled,
		cleanRuntimeDirectory: binaryDirectory,
		externalGrammarDeletion: { selectedAssets: [], identical: true, withDecoy, withoutDecoy },
		fixtureSha256: sha256(join(repository, "scripts/qa/fixtures/read-summary-provider.mjs")),
	};
}
