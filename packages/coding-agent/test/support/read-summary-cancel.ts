import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "../../../agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { createReadTool as createHarnessRead } from "../../../agent/src/harness/tools/read.ts";
import { type ReadFolder, selectedReadFolder } from "../../../agent/src/harness/utils/read-folders/index.ts";
import { createReadTool } from "../../src/core/tools/read.ts";
import {
	assertSummary,
	invocation,
	jsonSource,
	privateDir,
	readerNames,
	readers,
	textOutput,
} from "./read-summary-fixture.ts";

async function bounded<T>(signal: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			signal,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Read event deadline exceeded")), 5000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function cancellationParity() {
	return privateDir(async (cwd) => {
		const path = join(cwd, "source.json");
		await writeFile(path, jsonSource());
		const receipts = [];
		for (const name of readerNames) {
			const early = new AbortController();
			early.abort();
			await assert.rejects(readers(cwd).read(name, { path }, early.signal));
			for (let cycle = 0; cycle < 3; cycle++) {
				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const drained = Promise.withResolvers<void>();
				let folderCalls = 0;
				const folder: ReadFolder = {
					...selectedReadFolder,
					fold: (input) => {
						folderCalls++;
						return selectedReadFolder.fold(input);
					},
				};
				const controller = new AbortController();
				class GatedEnv extends NodeExecutionEnv {
					override async readBinaryFile(file: string, context: Context) {
						started.resolve();
						await release.promise;
						try {
							return await super.readBinaryFile(file, context);
						} finally {
							drained.resolve();
						}
					}
				}
				const pending =
					name === "coding-agent"
						? createReadTool(cwd, {
								folder,
								operations: {
									access: async () => {},
									readFile: async (file) => {
										started.resolve();
										await release.promise;
										try {
											return await readFile(file);
										} finally {
											drained.resolve();
										}
									},
								},
							}).execute("blocked", { path }, controller.signal)
						: createHarnessRead({ folder }).execute(
								"blocked",
								{ path },
								() => {},
								{ env: new GatedEnv({ cwd }) },
								invocation,
								withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
							);
				// Subscribe before abort; the test deadline is a fence, never a scheduling mechanism.
				const rejected = assert.rejects(pending);
				try {
					await bounded(started.promise);
					controller.abort();
					controller.abort();
					const freshText = JSON.stringify({ values: JSON.parse(jsonSource()), cycle }, null, 2);
					await writeFile(path, freshText);
					const fresh = readers(cwd, { folder });
					assertSummary(textOutput(await fresh.read(name, { path })));
					release.resolve();
					await bounded(rejected);
					await bounded(drained.promise);
					assert.equal(folderCalls, 1, `${name}: only the new read may fold`);
					assert.equal(textOutput(await fresh.read(name, { path, offset: 1 })), freshText);
					receipts.push({ reader: name, cycle, oldRejected: true, freshFoldCalls: folderCalls });
				} finally {
					controller.abort();
					release.resolve();
					await bounded(rejected);
				}
			}
		}
		return { passed: true, cases: receipts };
	});
}
