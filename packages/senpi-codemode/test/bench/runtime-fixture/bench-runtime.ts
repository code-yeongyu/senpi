import { createInterface } from "node:readline";
import { CPU_BOUNDARY } from "../../../scripts/bench-cpu-contract.ts";
import { implementedScenarios } from "../../../scripts/bench-scenarios.ts";

const requests = createInterface({ input: process.stdin });
const steps = implementedScenarios.flatMap(({ name }) => [-1, 0, 1, 2].map((rep) => ({ name, rep })));
let index = 0;
for await (const _request of requests) {
	if (process.env.BENCH_FIXTURE_FAILURE === "exit") break;
	const step = steps[index++];
	if (!step) throw new Error("unexpected request after the last sample");
	const sample = {
		cpuMs: 100,
		wallMs: 100,
		hostCpuMs: 100,
		kernelCpuMs: 0,
		...(step.name === "warm-cell-1000" || step.name === "tool-compose-100" ? { p95Ms: 1 } : {}),
	};
	console.log(
		`BENCH_RUNTIME:${JSON.stringify({
			cpuBoundary: CPU_BOUNDARY,
			hostRuntime: "bun",
			hostVersion: "fixture",
			runtimeVersion: "fixture",
			loadavg: [Number(process.env.BENCH_FIXTURE_REPORT_LOAD ?? 0), 0, 0],
			scenarios: { [step.name]: step.rep < 0 ? [] : [sample] },
		})}`,
	);
}
requests.close();
