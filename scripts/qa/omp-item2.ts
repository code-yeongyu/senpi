import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { runEvalAgent } from "../../packages/senpi-codemode/src/bridges/agent-bridge.ts";
import { marshalToolResult, toolResultIsError } from "../../packages/senpi-codemode/src/tool/image.ts";
import { catchCode, create, handle, inspectById, operations, setup } from "../../packages/senpi-codemode/test/workpool/cells.ts";
import { agentSpec, availability, fixture, hostResult, items, languages, poolId, receipt, record } from "../../packages/senpi-codemode/test/workpool/fixture.ts";
import { malformedHandles } from "../../packages/senpi-codemode/test/workpool/handle-fixtures.ts";
import { runInstalledPlugin } from "./omp-item2-plugin.mjs";

async function preludeParity() {
	const results = [];
	for (const language of languages) {
		assert(availability[language].detected.ok, `Required interpreter unavailable: ${language}`);
		const calls: Array<{ name: string; args: unknown }> = [];
		const f = await fixture(async (name, args) => {
			calls.push({ name, args });
			return hostResult(typeof args === "object" && args !== null && "op" in args && args.op === "push" ? receipt : record);
		});
		try {
			const result = await f.run(language, [setup[language], create[language], operations[language]].join("\n"));
			assert.equal(toolResultIsError(result), false, JSON.stringify(result));
			assert.deepEqual(calls, [
				{ name: "workpool", args: { op: "create", name: "batch", agent: agentSpec, mode: "fresh" } },
				{ name: "workpool", args: { op: "push", pool_id: poolId, items } },
				...["inspect", "close", "cancel"].map(op => ({ name: "workpool", args: { op, pool_id: poolId } })),
			]);
			const reset = await f.run(language, inspectById(language, poolId), true);
			assert.deepEqual(reset.details.jsonOutputs, [{ inspection: marshalToolResult(hostResult(record)) }]);
			results.push({ language, runtime: availability[language].detected, calls, output: result.details.jsonOutputs, reset: reset.details.jsonOutputs });
		} finally { await f.manager.dispose(); }
	}
	return results;
}

async function handleAndUnavailable() {
	for (const details of malformedHandles) {
		await assert.rejects(runEvalAgent({ prompt: "fixture", handle: true }, {
			callId: "legacy", taskToolName: "task", executeTool: async () => ({ content: [{ type: "text", text: "Started st_deadbeef; related st_abcdef" }], details }),
		}), { code: "invalid_task_handle" });
	}
	const results = [];
	for (const language of languages) {
		assert(availability[language].detected.ok, `Required interpreter unavailable: ${language}`);
		const f = await fixture(async (name) => {
			if (name === "task") return hostResult({ task_id: "st_abcd" });
			throw Object.assign(new Error("Host tool is not registered"), { code: "unknown_tool" });
		});
		try {
			const result = await f.run(language, `${setup[language]}\n${catchCode(language, create[language])}\n${catchCode(language, handle[language])}`);
			assert.deepEqual(result.details.jsonOutputs, [{ code: "workpool_unavailable" }, { code: "invalid_task_handle" }], JSON.stringify(result));
			results.push({ language, errors: result.details.jsonOutputs });
		} finally { await f.manager.dispose(); }
	}
	return { malformedDetailsRejected: malformedHandles.length, results };
}

const { values } = parseArgs({ options: { case: { type: "string" }, out: { type: "string" } } });
assert(values.out && isAbsolute(values.out), "--out must be an absolute JSON path");
assert(values.case === "prelude-host-parity" || values.case === "typed-handle-and-unavailable", "Unknown --case");
const startedAt = new Date().toISOString();
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourcePaths = ["src/bridges/agent-bridge.ts", "src/kernels/js/worker-runtime.js", "src/kernels/js/workpool.js", "src/kernels/py/prelude.py", "src/kernels/rb/prelude.rb", "src/kernels/rb/workpool.rb", "src/kernels/jl/prelude.jl"];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash("sha256").update(await readFile(`packages/senpi-codemode/${path}`)).digest("hex")])));
await mkdir(dirname(values.out), { recursive: true });
try {
	const preludes = values.case === "prelude-host-parity" ? await preludeParity() : await handleAndUnavailable();
	const plugin = await runInstalledPlugin(join(dirname(values.out), `${values.case}-cli`));
	const blocked = values.case === "prelude-host-parity" && !plugin.aggregateVerified ? plugin.blocked : undefined;
	await writeFile(values.out, JSON.stringify({ case: values.case, passed: !blocked, blocked, startedAt, finishedAt: new Date().toISOString(), head, sourceHashes, preludes, plugin, cleanup: "CLI, kernels, bridge and sandbox disposed", paidProviderCalls: 0 }, null, 2));
	console.log(JSON.stringify({ case: values.case, passed: !blocked, blocked, producerSha: plugin.producerSha }));
	if (blocked) process.exitCode = 2;
} catch (error) {
	await writeFile(values.out, JSON.stringify({ case: values.case, passed: false, startedAt, finishedAt: new Date().toISOString(), head, sourceHashes, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
	throw error;
}
