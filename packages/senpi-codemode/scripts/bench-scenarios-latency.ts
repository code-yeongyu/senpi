import type { EvalLanguage } from "../src/tool/types.ts";
import { INTERRUPT_READY, interruptCell, readCell, scalarCell, sleepCell } from "./bench-cells.ts";
import { kernelCpuMs, type Measured, measure, measured, timed } from "./bench-measure.ts";
import type { BenchMemory, BenchSession } from "./bench-session.ts";

export interface ScenarioContext {
	readonly language: EvalLanguage;
	readonly session: BenchSession;
	readonly fresh: (memory?: BenchMemory) => Promise<BenchSession>;
	readonly rep: number;
}

export interface Scenario {
	readonly name: string;
	run(context: ScenarioContext): Promise<Measured>;
}

const WARM_CELLS_PER_REP = 20;
const ROUND_TRIPS_PER_REP = 10;

/** Construct -> first result on a fresh session; the new child's CPU since spawn is all start-up work. */
const coldStart: Scenario = {
	name: "cold-start",
	async run({ language, fresh, rep }) {
		const session = await fresh();
		try {
			const { value, window } = await timed(async () => {
				const kernel = await session.kernel();
				return await kernel.run({ cellId: `bench-cold-${rep}`, code: scalarCell[language], timeoutMs: 120_000 });
			});
			if (!value.ok) throw new Error(`cold start failed: ${value.error.message}`);
			const after = await session.cpu();
			return measured(window, kernelCpuMs([], after), { observations: { value: value.valueRepr ?? null } });
		} finally {
			await session.dispose();
		}
	},
};

const warmCell: Scenario = {
	name: "warm-cell",
	run: async ({ language, session }) =>
		await measure(session, async () => {
			for (let index = 0; index < WARM_CELLS_PER_REP; index += 1) await session.cell(scalarCell[language]);
			return { observations: { cells: WARM_CELLS_PER_REP } };
		}),
};

/** Real clock: a 1 s detach window, submit -> the call returning; the parked kernel only sleeps. */
const detach: Scenario = {
	name: "detach",
	async run({ language, session, rep }) {
		const cellId = `bench-detach-${rep}-${crypto.randomUUID()}`;
		const before = await session.cpu();
		const { value, window } = await timed(async () => await session.detach(cellId, sleepCell(language, 5)));
		await session.stopDetached(cellId);
		await session.cell(scalarCell[language]);
		const after = await session.cpu();
		return measured(window, kernelCpuMs(before, after), { observations: { detached: value.includes(cellId) } });
	},
};

const interrupt: Scenario = {
	name: "interrupt",
	async run({ language, session, rep }) {
		const before = await session.cpu();
		const cellId = `bench-interrupt-${rep}`;
		const started = Promise.withResolvers<void>();
		let readiness = "";
		const kernel = await session.kernel((message) => {
			if (message.type !== "text") return;
			readiness += message.data;
			if (readiness.includes(INTERRUPT_READY)) started.resolve();
		});
		const running = kernel.run({
			cellId,
			code: interruptCell[language],
			timeoutMs: 120_000,
		});
		await Promise.race([
			started.promise,
			running.then(() => {
				throw new Error("interrupt cell ended before its readiness signal");
			}),
		]);
		const { value, window } = await timed(async () => {
			const handle = await kernel.interrupt("bench interrupt", cellId);
			const settled = await running;
			return { settled, retained: await handle.stateRetained };
		});
		const after = await session.cpu();
		return measured(window, kernelCpuMs(before, after), {
			observations: { settledOk: value.settled.ok, stateRetained: value.retained },
		});
	},
};

const toolRoundTrip: Scenario = {
	name: "tool-roundtrip",
	run: async ({ language, session }) => {
		const callsBefore = session.toolCalls();
		return await measure(session, async () => {
			let bytes = 0;
			for (let index = 0; index < ROUND_TRIPS_PER_REP; index += 1) {
				bytes += Number((await session.cell(readCell(language, session.fixturePath))).text.trim());
			}
			return {
				observations: { bytesPerRead: bytes / ROUND_TRIPS_PER_REP, bridgeCalls: session.toolCalls() - callsBefore },
			};
		});
	},
};

export const latencyScenarios: readonly Scenario[] = [coldStart, warmCell, detach, interrupt, toolRoundTrip];
