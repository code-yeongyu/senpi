import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ALLOCATION_BYTES,
	allocateCell,
	collectionCell,
	composeCell,
	dropCell,
	futureCapabilityCell,
	readCell,
} from "../../scripts/bench-cells.ts";
import { workloadScenarios } from "../../scripts/bench-scenarios-workload.ts";
import { type BenchMemory, createBenchSession, loadTarget } from "../../scripts/bench-session.ts";
import { createInterpreterDetector } from "../../src/interpreters/detect.ts";

const languages = ["js", "py", "rb", "jl"] as const;
const detector = createInterpreterDetector();
const available = new Map(
	await Promise.all(languages.map(async (language) => [language, (await detector.detect(language)).ok] as const)),
);

describe.each(languages)("benchmark fixtures in %s", (language) => {
	const supported = process.platform !== "win32" && available.get(language) && available.get("py");
	it.skipIf(!supported)(
		"streams the ten-mebibyte workload into a real spill file",
		async () => {
			// Given the real eval tool, including each language's stdout adapter.
			const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
			const fresh = () => createBenchSession(modules, language);
			const session = await fresh();
			try {
				// When the output-spill workload runs through the same measured path.
				const scenario = workloadScenarios.find((entry) => entry.name === "output-spill");
				if (!scenario) throw new Error("output-spill scenario missing");
				const result = await scenario.run({ language, session, fresh, rep: 0 });
				// Then actual retained bytes prove output reached the host.
				expect(result.observations?.spillBytes).toBeGreaterThanOrEqual(10 * 1024 * 1024);
				expect(result.observations?.spillSha256).toBeTypeOf("string");
			} finally {
				await session.dispose();
			}
		},
		120_000,
	);
	it.skipIf(!supported)(
		"reads the actual one-kibibyte fixture through the host bridge",
		async () => {
			// Given the real language kernel and a deterministic file fixture.
			const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
			const session = await createBenchSession(modules, language);
			try {
				// When the cell calls the host's read tool.
				const result = await session.cell(readCell(language, session.fixturePath));
				// Then the payload and bridge observation agree.
				expect(Number(result.text.trim())).toBe(1024);
				expect(session.toolCalls()).toBe(1);
			} finally {
				await session.dispose();
			}
		},
		120_000,
	);

	it.skipIf(!supported)(
		"composes four host results in input order",
		async () => {
			// Given the same deterministic four-wide batch in each language.
			const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
			const session = await createBenchSession(modules, language);
			try {
				// When one batch runs through the real bridge.
				const result = await session.cell(composeCell(language, 0));
				// Then the model-visible values preserve input order.
				expect(result.text.trim().replace(/^["']|["']$/gu, "")).toBe("item-0,item-1,item-2,item-3");
				expect(session.toolCalls()).toBe(4);
			} finally {
				await session.dispose();
			}
		},
		120_000,
	);

	it.skipIf(!supported)(
		"probes optional capabilities without executing a missing helper",
		async () => {
			// Given the target's own kernel prelude.
			const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
			const session = await createBenchSession(modules, language);
			try {
				// When the benchmark discovers future workload capabilities.
				const result = await session.cell(futureCapabilityCell[language]);
				// Then discovery itself does not make external tool calls.
				expect(result.text).toBeTypeOf("string");
				expect(session.toolCalls()).toBe(0);
			} finally {
				await session.dispose();
			}
		},
		120_000,
	);
});

it.skipIf(process.platform === "win32" || !available.get("js"))(
	"collects the existing 150 MiB fixture and reports released live memory",
	async () => {
		// Given the existing memory test's lowered watermark and disabled ceiling.
		const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
		const fresh = (memory?: BenchMemory) => createBenchSession(modules, "js", memory);
		const session = await fresh();
		try {
			// When the complete allocation/drop/collection scenario executes.
			const scenario = workloadScenarios.find((entry) => entry.name === "gc-allocate-drop");
			if (!scenario) throw new Error("gc-allocate-drop scenario missing");
			const result = await scenario.run({ language: "js", session, fresh, rep: 0 });
			// Then reported collection and released live memory prove real GC work.
			expect(result.observations?.collections).toBeGreaterThan(0);
			expect(result.observations?.liveBytesAllocated).toBeGreaterThanOrEqual(ALLOCATION_BYTES * 0.9);
			expect(result.observations?.liveBytesDropped).toBeLessThan(ALLOCATION_BYTES * 0.5);
		} finally {
			await session.dispose();
		}
	},
	120_000,
);

it.skipIf(process.platform === "win32" || !available.get("jl") || !available.get("py"))(
	"allocates, touches, and releases the Julia GC workload",
	async () => {
		// Given a real Julia kernel and the benchmark's native bulk-allocation cell.
		const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
		const session = await createBenchSession(modules, "jl");
		try {
			// When its payload is allocated, both ends are touched before release.
			await session.cell(allocateCell.jl);
			const allocated = await session.cell(
				'string(length(bench_big), ",", Int(first(bench_big)), ",", Int(last(bench_big)))',
			);
			expect(allocated.text.trim().replace(/^"|"$/gu, "")).toBe(`${ALLOCATION_BYTES},1,1`);
			await session.cell(dropCell.jl);
			await session.cell(collectionCell.jl);
			// Then the benchmark no longer retains the allocated vector.
			expect((await session.cell("isnothing(bench_big)")).text.trim()).toBe("true");
		} finally {
			await session.dispose();
		}
	},
	120_000,
);
