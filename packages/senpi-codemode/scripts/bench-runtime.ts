import { loadavg } from "node:os";
import { createInterface } from "node:readline";
import type { EvalLanguage } from "../src/tool/types.ts";
import { futureCapabilityCell, scalarCell, versionCell } from "./bench-cells.ts";
import type { Measured } from "./bench-measure.ts";
import { implementedScenarios } from "./bench-scenarios.ts";
import { type BenchMemory, createBenchSession, loadTarget } from "./bench-session.ts";
import type { RuntimeReport } from "./bench-worker.ts";

const BENCH_RUNTIME_PREFIX = "BENCH_RUNTIME:";
const WARM_UP_CELLS = 5;

function languageFrom(value: string | undefined): EvalLanguage {
	switch (value) {
		case "js":
		case "py":
		case "rb":
		case "jl":
			return value;
		default:
			throw new RangeError(`bench language ${String(value)}`);
	}
}

/** Each request advances one rehearsal or measured repetition; idle sides never run a workload. */
async function* samples(
	target: string,
	language: EvalLanguage,
	options: { readonly reps: number; readonly only?: string },
): AsyncGenerator<RuntimeReport> {
	const only = options.only?.split(",");
	const selected = implementedScenarios.filter((scenario) => only === undefined || only.includes(scenario.name));
	const modules = await loadTarget(target);
	const fresh = (memory?: BenchMemory) => createBenchSession(modules, language, memory);
	const session = await fresh();
	try {
		for (let index = 0; index < WARM_UP_CELLS; index += 1) await session.cell(scalarCell[language]);
		const runtimeVersion = (await session.cell(versionCell[language])).text.trim().replace(/^["']|["']$/gu, "");
		const scenarios: Record<string, Measured[]> = {};
		const capabilities = (await session.cell(futureCapabilityCell[language])).text;
		const pending = [
			...(capabilities.includes("wait") ? ["wait-1000-handles"] : []),
			...(capabilities.includes("install") ? ["managed-install", "install-local-fixtures"] : []),
			...(capabilities.includes("callback") ? ["callback-roundtrip-js-py"] : []),
			...("sandbox" in modules.settings.defaultCodemodeSettings
				? ["sandbox-execute", "sandbox-compose", "sandbox-runaway"]
				: []),
		];
		// A newly shipped capability without a workload must invalidate, not silently skip.
		for (const name of pending) scenarios[name] = [];
		const report = (name: string, values: Measured[]): RuntimeReport => ({
			hostRuntime: process.versions.bun === undefined ? "node" : "bun",
			hostVersion: process.versions.bun ?? process.versions.node,
			runtimeVersion,
			loadavg: loadavg(),
			scenarios: { ...scenarios, [name]: values },
		});
		for (const scenario of selected) {
			// Cold-start windows stay cold; other workloads rehearse their own bridge/JIT paths.
			if (scenario.name !== "cold-start") await scenario.run({ language, session, fresh, rep: -1 });
			for (let index = 0; index < WARM_UP_CELLS; index += 1) await session.cell(scalarCell[language]);
			yield report(scenario.name, []);
			for (let rep = 0; rep < options.reps; rep += 1)
				yield report(scenario.name, [await scenario.run({ language, session, fresh, rep })]);
		}
	} finally {
		await session.dispose();
	}
}

/** Separate host processes preserve engine identity and process-level CPU attribution. */
async function main(): Promise<void> {
	const [target, languageArg, repsArg, mode] = process.argv.slice(2);
	if (!target) throw new RangeError("bench runtime needs a target");
	const language = languageFrom(languageArg);
	const reps = Number(repsArg ?? "3");
	const stream = samples(target, language, { reps, ...(mode && mode !== "--stepped" ? { only: mode } : {}) });
	if (mode === "--stepped") {
		const requests = createInterface({ input: process.stdin });
		try {
			for await (const _request of requests) {
				const next = await stream.next();
				if (next.done) throw new RangeError("measurement requested after the final repetition");
				console.log(`${BENCH_RUNTIME_PREFIX}${JSON.stringify(next.value)}`);
			}
		} finally {
			requests.close();
			await stream.return(undefined);
		}
		return;
	}
	let report: RuntimeReport | undefined;
	const scenarios: Record<string, Measured[]> = {};
	for await (const sample of stream) {
		for (const [name, values] of Object.entries(sample.scenarios)) (scenarios[name] ??= []).push(...values);
		report = { ...sample, scenarios };
	}
	if (!report) throw new RangeError("no benchmark scenarios selected");
	console.log(`${BENCH_RUNTIME_PREFIX}${JSON.stringify(report)}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
