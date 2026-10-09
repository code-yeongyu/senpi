import { spawn } from "node:child_process";
import { crashCell, generationCell } from "./bench-cells.ts";
import { kernelCpuMs, measured, timed } from "./bench-measure.ts";
import type { Scenario } from "./bench-scenarios-latency.ts";

const QUEUED = 100;

/** Direct children of this host process; `pgrep` never lists itself. */
function childPids(): Promise<Set<number>> {
	return new Promise((resolve, reject) => {
		const child = spawn("pgrep", ["-P", String(process.pid)], { stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.once("error", reject);
		child.once("close", () => resolve(new Set(stdout.split(/\s+/u).filter(Boolean).map(Number))));
	});
}

export const crashQueue100: Scenario = {
	name: "crash-queue-100",
	async run({ language, fresh, rep }) {
		const baseline = await childPids();
		const session = await fresh();
		let disposed = false;
		try {
			const kernel = await session.kernel();
			const warm = await kernel.run({
				cellId: `bench-crash-warm-${rep}`,
				code: generationCell[language],
				timeoutMs: 120_000,
			});
			if (!warm.ok) throw new Error(`crash-queue-100 warm-up failed: ${warm.error.message}`);
			const before = await session.cpu();
			const executions = new Map<string, number>();
			const { value, window } = await timed(async () => {
				const crash = kernel.run({ cellId: `bench-crash-${rep}`, code: crashCell[language], timeoutMs: 60_000 });
				const queued = Array.from({ length: QUEUED }, (_, index) => {
					const cellId = `bench-queued-${rep}-${index}`;
					return kernel.run({
						cellId,
						code: generationCell[language],
						timeoutMs: 60_000,
						onStarted: () => executions.set(cellId, (executions.get(cellId) ?? 0) + 1),
					});
				});
				return { crash: await crash, queued: await Promise.allSettled(queued) };
			});
			const settled = value.queued.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
			const generations = new Set(settled.flatMap((result) => (result.ok ? [result.valueRepr ?? ""] : [])));
			const counts = [...executions.values()];
			const after = await session.cpu(settled.some((result) => result.ok));
			await session.dispose();
			disposed = true;
			const remaining = [...(await childPids())].filter((pid) => !baseline.has(pid)).length;
			return measured(window, kernelCpuMs(before, after), {
				observations: {
					crashSettledOk: value.crash.ok,
					queuedOk: settled.filter((result) => result.ok).length,
					queuedFailed: QUEUED - settled.filter((result) => result.ok).length,
					maxExecutionsPerId: counts.length === 0 ? 0 : Math.max(...counts),
					idsExecuted: counts.length,
					replacements: [...generations].filter((generation) => generation !== warm.valueRepr).length,
					generations: generations.size,
					remainingProcesses: remaining,
				},
			});
		} finally {
			if (!disposed) await session.dispose();
		}
	},
};
