import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	collectionCell,
	composeCell,
	datasetCell,
	queryCell,
	SPILL_LINE_BYTES,
	SPILL_LINES,
	scalarCell,
	spillCell,
} from "./bench-cells.ts";
import { percentile } from "./bench-stats.ts";
import { measure } from "./bench-measure.ts";
import type { Scenario } from "./bench-scenarios-latency.ts";
import { gcAllocateDrop } from "./bench-scenarios-memory.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const warmCell1000: Scenario = {
	name: "warm-cell-1000",
	run: async ({ language, session }) => {
		const callsBefore = session.toolCalls();
		const result = await measure(session, async () => {
			const walls: number[] = [];
			for (let index = 0; index < 1000; index += 1) walls.push((await session.cell(scalarCell[language])).wallMs);
			return {
				p95Ms: percentile(walls, 0.95),
				observations: { p50Ms: percentile(walls, 0.5), bridgeCalls: session.toolCalls() - callsBefore },
			};
		});
		const kernel = await session.kernel();
		const after = await kernel.run({
			cellId: `bench-live-${crypto.randomUUID()}`,
			code: collectionCell[language],
			timeoutMs: 60_000,
		});
		if (!after.ok) throw new Error(`post-GC observation failed: ${after.error.message}`);
		return { ...result, observations: { ...result.observations, liveBytes: after.memory?.liveBytes ?? null } };
	},
};

const toolCompose100: Scenario = {
	name: "tool-compose-100",
	run: async ({ language, session }) => {
		const callsBefore = session.toolCalls();
		return await measure(session, async () => {
			const walls: number[] = [];
			const texts: string[] = [];
			for (let batch = 0; batch < 25; batch += 1) {
				const outcome = await session.cell(composeCell(language, batch));
				walls.push(outcome.wallMs);
				texts.push(outcome.text);
			}
			const visible = texts.join("\n");
			return {
				p95Ms: percentile(walls, 0.95),
				observations: {
					resultHash: sha256(visible),
					modelVisibleBytes: Buffer.byteLength(visible),
					toolCalls: session.toolCalls() - callsBefore,
				},
			};
		});
	},
};

const persistentDataReuse: Scenario = {
	name: "persistent-data-reuse",
	run: async ({ language, session }) =>
		await measure(session, async () => {
			const texts = [(await session.cell(datasetCell[language])).text];
			for (let query = 0; query < 100; query += 1) texts.push((await session.cell(queryCell(language, query))).text);
			return { observations: { resultHash: sha256(texts.join("\n")) } };
		}),
};

async function filesUnder(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

const outputSpill: Scenario = {
	name: "output-spill",
	run: async ({ language, session }) => {
		const existing = new Set(await filesUnder(session.artifactsDir));
		const result = await measure(session, async () => {
			const outcome = await session.cell(spillCell[language]);
			return { observations: { retainedPreviewBytes: Buffer.byteLength(outcome.text) } };
		});
		const spills = (await filesUnder(session.artifactsDir)).filter((path) => !existing.has(path));
		const sizes = await Promise.all(spills.map(async (path) => ({ path, size: (await stat(path)).size })));
		const largest = sizes.sort((a, b) => b.size - a.size)[0];
		const spill = largest === undefined ? null : await readFile(largest.path);
		return {
			...result,
			observations: {
				...result.observations,
				intendedStreamBytes: SPILL_LINES * (SPILL_LINE_BYTES + 1),
				spillBytes: spill?.byteLength ?? null,
				spillSha256: spill === null ? null : sha256(spill),
			},
		};
	},
};

export const workloadScenarios: readonly Scenario[] = [
	warmCell1000,
	toolCompose100,
	persistentDataReuse,
	outputSpill,
	gcAllocateDrop,
];
