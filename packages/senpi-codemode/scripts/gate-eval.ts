import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { baselineApprovals, readBaseBaseline, reviewBaselineChanges } from "./gate-baseline-review.ts";
import { compareReports } from "./gate-compare.ts";
import { runProcess } from "./gate-process.ts";
import { writeGateOutput } from "./gate-output.ts";
import { measurePolicies } from "./gate-policy.ts";
import {
	allowlistSchema, canonical, GateInputError, type GateReport, goldenSchema, readReport, runtimesSchema,
} from "./gate-report.ts";
import { measureSuite } from "./gate-suite.ts";
import { measureSurfaces } from "./gate-surfaces.ts";
import { assertFreshTarget } from "./gate-target.ts";
import { cleanupFailures, cleanupSchema } from "./gate-resources.ts";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptRoot, "..");
const runtimeReportSchema = Type.Object({
	helperNames: Type.Array(Type.String()),
	witnesses: Type.Record(Type.String(), Type.Unknown()),
	hostRuntime: Type.Union([Type.Literal("bun"), Type.Literal("node")]),
	memory: Type.Optional(Type.Unknown()),
	cleanup: cleanupSchema,
	liveTimers: Type.Array(Type.String()),
});
const importsSchema = Type.Object({
	extension: Type.Array(Type.String()),
	firstKernel: Type.Array(Type.String()),
	sizes: Type.Record(Type.String(), Type.Number()),
	classification: Type.Array(Type.Object({ url: Type.String(), scope: Type.String() })),
	virtualSpecifiers: Type.Array(Type.String()),
});

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			baseline: { type: "string", default: "test/gate/baseline.json" },
			target: { type: "string", default: packageRoot },
			report: { type: "string", default: "gate-report.json" },
			"write-baseline": { type: "boolean", default: false },
			"base-ref": { type: "string" },
		},
	});
	const requestedTarget = resolve(values.target);
	const isPackage = basename(requestedTarget) === "senpi-codemode" && basename(dirname(requestedTarget)) === "packages";
	const target = isPackage ? requestedTarget : resolve(requestedTarget, "packages/senpi-codemode");
	const failures: string[] = [];
	const unmeasured: string[] = [];
	const observations: Record<string, unknown> = {};
	const report: GateReport = {
		version: 1, prompts: {}, schemas: {}, helperCensus: {}, runtimes: [], invariants: {}, imports: {},
		observations, unmeasured,
	};
	let additions: string[] = [];
	try {
		await assertFreshTarget(target);
		const manifest: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/runtimes.json"), "utf8"));
		const golden: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/helpers.golden.json"), "utf8"));
		const allowlist: unknown = JSON.parse(await readFile(resolve(packageRoot, "test/gate/allowlist.json"), "utf8"));
		if (!Check(runtimesSchema, manifest) || !Check(goldenSchema, golden) || !Check(allowlistSchema, allowlist))
			throw new GateInputError("runtime manifest, helper golden or allowlist");
		Object.assign(report, await measureSurfaces(target));
		report.invariants = await measurePolicies(target);
		const revision = await runProcess(["git", "rev-parse", "HEAD"], target);
		if (revision.exitCode !== 0) throw new GateInputError("target checkout revision");
		observations.targetRevision = revision.stdout.trim();
		observations.platform = process.platform;
		for (const runtime of manifest.required) {
			try {
				const command = runtime.jsRuntime ?? { js: "bun", py: "python3", rb: "ruby", jl: "julia" }[runtime.language];
				const version = await runProcess([command, "--version"], target).catch((error: unknown) => {
					if (error instanceof Error && "code" in error && error.code === "ENOENT")
						return { exitCode: 1, stdout: "", stderr: error.message };
					throw error;
				});
				const available = version.exitCode === 0;
				observations[`${runtime.id}/version`] = version.stdout.trim();
				report.runtimes.push({ id: runtime.id, available });
				if (!available) {
					failures.push(`required interpreter missing: ${runtime.id}`);
					unmeasured.push(`helperCensus/${runtime.id}`, `invariants/${runtime.id}`);
					if (runtime.id === "js-bun") unmeasured.push("helperCensus/js");
					continue;
				}
				const host = runtime.jsRuntime ?? "bun";
				const probe = await runProcess([
					host, ...(host === "node" ? ["--import", "tsx"] : []),
					resolve(scriptRoot, "gate-runtime.ts"), target, runtime.language,
					resolve(packageRoot, "test/gate/helpers.golden.json"),
				], packageRoot);
				const line = probe.stdout.split("\n").find((entry) => entry.startsWith("GATE_RUNTIME:"));
				if (probe.exitCode !== 0 || !line) {
					failures.push(`runtime ${runtime.id} failed: ${probe.stderr || probe.stdout}`);
					unmeasured.push(`helperCensus/${runtime.id}`, `invariants/${runtime.id}`);
					if (runtime.id === "js-bun") unmeasured.push("helperCensus/js");
					continue;
				}
				const measured: unknown = JSON.parse(line.slice("GATE_RUNTIME:".length));
				if (!Check(runtimeReportSchema, measured)) throw new GateInputError(`runtime ${runtime.id} report`);
				if (runtime.jsRuntime !== undefined && measured.hostRuntime !== runtime.jsRuntime)
					failures.push(`required interpreter mismatch: ${runtime.id} ran ${measured.hostRuntime}`);
				observations[`${runtime.id}/memoryAfter50Cells`] = measured.memory;
				const names = measured.helperNames.sort();
				report.helperCensus[runtime.id] = names;
				if (runtime.id === "js-bun") report.helperCensus.js = names;
				for (const name of golden[runtime.language] ?? []) {
					if (!names.includes(name)) failures.push(`helper census: ${runtime.language} removed [${name}]`);
				}
				for (const [scenario, witness] of Object.entries(measured.witnesses))
					report.invariants[`${runtime.id}/${scenario}`] = witness;
				report.invariants[`${runtime.id}/cleanup`] = measured.cleanup;
				failures.push(...cleanupFailures(measured.cleanup, runtime.id),
					...measured.liveTimers.map((site) => `cleanup ${runtime.id}: live ${site}`));
			} catch (error: unknown) {
				failures.push(`runtime ${runtime.id} failed: ${error instanceof Error ? error.message : canonical(error)}`);
				if (!report.runtimes.some((item) => item.id === runtime.id)) report.runtimes.push({ id: runtime.id, available: false });
				unmeasured.push(`helperCensus/${runtime.id}`, `invariants/${runtime.id}`);
				if (runtime.id === "js-bun") unmeasured.push("helperCensus/js");
			}
		}
		if (process.env.SENPI_CODEMODE_GATE_MUTATE === "drop-phase") {
			report.helperCensus.js = (report.helperCensus.js ?? []).filter((name) => name !== "phase");
		}
		{
			try {
				const census = await runProcess([
					"node", "--import", "tsx", "--import", resolve(scriptRoot, "gate-import-observer.ts"),
					resolve(scriptRoot, "gate-imports.ts"), target,
				], packageRoot);
				const line = census.stdout.split("\n").find((entry) => entry.startsWith("GATE_IMPORTS:"));
				if (census.exitCode !== 0 || !line) {
					failures.push(`import census failed: ${census.stderr || census.stdout}`);
					unmeasured.push("imports");
				}
				else {
					const measured: unknown = JSON.parse(line.slice("GATE_IMPORTS:".length));
					if (!Check(importsSchema, measured)) throw new GateInputError("import census report");
					report.imports = { extension: measured.extension, firstKernel: measured.firstKernel };
					observations.importBytes = measured.sizes;
					observations.importClassification = measured.classification;
					observations.virtualSpecifiers = measured.virtualSpecifiers;
					console.log(`Scoped import census: extension=${measured.extension.length}, firstKernel=${measured.firstKernel.length}, host=${new Set(measured.classification.filter((frame) => frame.scope === "host").map((frame) => frame.url)).size}`);
				}
			} catch (error: unknown) {
				failures.push(`import census failed: ${error instanceof Error ? error.message : canonical(error)}`);
				unmeasured.push("imports");
			}
			// OS-specific contracts may legitimately skip on another OS. Their real outcomes
			// remain visible; the suite's exit status gates every active contract independently.
			observations.legacyContracts = await measureSuite(target, resolve(packageRoot, "../../node_modules/vitest/vitest.mjs"))
				.catch((error: unknown) => {
					failures.push(error instanceof Error ? error.message : canonical(error));
					unmeasured.push("legacyContracts");
					return {};
				});
		}
		const baselinePath = resolve(values.baseline);
		const committed = values["write-baseline"] ? undefined : await readReport(baselinePath);
		const result = committed === undefined
			? { exitCode: failures.length ? 1 : 0, failures: [], additions: [] }
			: compareReports({
					baseline: committed, report,
					additions: Object.values(allowlist.nodes).flatMap((node) => node.additions),
				});
		failures.push(...result.failures);
		additions = result.additions;
		if (committed !== undefined) {
			const baseRef = values["base-ref"];
			const resolved = await readBaseBaseline({ baselinePath, env: process.env, ...(baseRef === undefined ? {} : { baseRef }) });
			if (resolved !== undefined) {
				console.log(`Baseline changes reviewed against merge base ${resolved.mergeBase}`);
				const approvals = baselineApprovals({ base: resolved.allowlist, head: allowlist });
				failures.push(...reviewBaselineChanges({ base: resolved.base, committed, report, ...approvals }));
			}
		}
	} catch (error: unknown) {
		failures.push(error instanceof Error ? error.message : canonical(error));
		for (const section of ["prompts", "schemas", "helperCensus", "invariants", "imports"] as const) {
			if (Object.keys(report[section]).length === 0) unmeasured.push(section);
		}
		if (observations.legacyContracts === undefined) unmeasured.push("legacyContracts");
		if (report.runtimes.length === 0) unmeasured.push("runtimes");
	}
	await writeGateOutput(resolve(values.report), `${JSON.stringify({ report, failures, additions }, null, 2)}\n`);
	if (values["write-baseline"] && failures.length === 0) {
		// The artifact retains every measured parent edge. The frozen baseline
		// needs only comparison inputs, not the unrelated host's trace or sizes.
		const baselineObservations = Object.fromEntries(Object.entries(observations)
			.filter(([key]) => key !== "importClassification" && key !== "importBytes"));
		await writeGateOutput(resolve(values.baseline), `${JSON.stringify({ ...report, observations: baselineObservations }, null, 2)}\n`);
	}
	console.log(`Gate report: ${resolve(values.report)}`);
	for (const failure of new Set(failures)) console.error(failure);
	if (failures.length > 0) {
		console.error("For reviewed changes on main, rebuild a clean main checkout and re-record with the head harness:");
		console.error("bun packages/senpi-codemode/scripts/gate-build.ts <clean-main-checkout>");
		console.error("bun run --cwd packages/senpi-codemode gate --target <clean-main-checkout> --baseline test/gate/baseline.json --write-baseline");
	}
	console.log(`gate: ${failures.length ? "FAIL" : "PASS"} (${Object.keys(report.prompts).length} prompt cells, ${report.runtimes.length} runtimes)`);
	process.exitCode = failures.length ? 1 : 0;
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : canonical(error));
	process.exitCode = 1;
});
