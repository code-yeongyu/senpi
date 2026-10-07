import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const repSchema = Type.Object({
	cpuMs: Type.Number(),
	wallMs: Type.Number(),
	p95Ms: Type.Optional(Type.Number()),
});
const blockSchema = Type.Object({ first: Type.Array(repSchema), second: Type.Array(repSchema) });
const sideSchema = Type.Object({ available: Type.Boolean(), version: Type.Optional(Type.String()) });

const savedReportSchema = Type.Object({
	reps: Type.Number(),
	injections: Type.Array(Type.Unknown()),
	calibrationOffset: Type.Optional(Type.Number()),
	blockLoads: Type.Array(Type.Number()),
	failures: Type.Array(Type.String()),
	runtimes: Type.Array(Type.Object({ id: Type.String(), base: sideSchema, head: sideSchema })),
	series: Type.Array(
		Type.Object({
			scenario: Type.String(),
			runtimeId: Type.String(),
			optional: Type.Optional(Type.Boolean()),
			present: Type.Object({ base: Type.Boolean(), head: Type.Boolean() }),
			calibration: Type.Array(blockSchema),
			comparison: Type.Array(blockSchema),
		}),
	),
});

export type SavedReport = Static<typeof savedReportSchema>;

export class RescoreError extends Error {
	readonly name = "RescoreError";
}

/** A measured report re-judged without new samples; it must hold the raw, un-injected measurements. */
export async function loadSavedReport(path: string): Promise<SavedReport> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!Check(savedReportSchema, value)) throw new RescoreError(`${path} is not a measured bench report`);
	if (value.injections.length > 0 || (value.calibrationOffset ?? 1) !== 1)
		throw new RescoreError(`${path} already carries injected samples; rescore its un-injected source report`);
	return value;
}
