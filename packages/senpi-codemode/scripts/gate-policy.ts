import { pathToFileURL } from "node:url";
import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { EvalToolDetails } from "../src/tool/types.ts";

/** Exact policy outcomes, not physical footprint or elapsed-time measurements. */
export async function measurePolicies(target: string): Promise<Record<string, unknown>> {
	const { defaultMemorySettings, defaultMemoryCeilingMb }: typeof import("../src/config/memory-settings.ts") = await import(
		pathToFileURL(`${target}/src/config/memory-settings.ts`).href
	);
	const { KernelMemoryPolicy }: typeof import("../src/kernels/shared/kernel-memory.ts") = await import(
		pathToFileURL(`${target}/src/kernels/shared/kernel-memory.ts`).href
	);
	const { EvalDetachedCellManager }: typeof import("../src/tool/detached-cell-manager.ts") = await import(
		pathToFileURL(`${target}/src/tool/detached-cell-manager.ts`).href
	);
	const mib = 1024 * 1024;
	const invariants: Record<string, unknown> = {
		memoryDefaults: defaultMemorySettings(8 * 1024 * mib),
		memoryCeilingPolicy: [4, 8, 16, 64].map((gib) => defaultMemoryCeilingMb(gib * 1024 * mib)),
	};
	for (const language of ["js", "py", "rb", "jl"] as const) {
		const collects = language === "js" || language === "py";
		const measure = collects ? "heap" : "footprint";
		const policy = new KernelMemoryPolicy(
			language, { gcWatermarkBytes: 32 * mib, noticeBytes: collects ? 64 * mib : 0, ceilingBytes: 128 * mib },
			{ collects },
		);
		const uncollected = policy.annotate({
			liveBytes: 160 * mib, measure, gcRan: false,
			...(collects ? { globals: [{ name: "uncollected_rows", bytes: 160 * mib }] } : {}),
		});
		const uncollectedPending = policy.recyclePending;
		const outcomes = [uncollected, ...[80, 80, 100, 160].map((live) => policy.annotate({
			liveBytes: live * mib, measure, gcRan: collects,
			...(collects ? { globals: [{ name: "rows", bytes: live * mib }] } : {}),
		}))];
		const pendingAfterBreach = policy.recyclePending;
		policy.recycleStarted();
		policy.kernelRetired();
		const fresh = policy.annotate({ liveBytes: mib, measure });
		const next = policy.annotate({ liveBytes: mib, measure });
		invariants[`${language}/memoryPolicy`] = {
			noticeCount: outcomes.filter((item) => item.notice !== undefined).length,
			globalNames: outcomes.find((item) => item.notice !== undefined)?.globals?.map((item) => item.name) ?? [],
			ceilingMarks: outcomes.filter((item) => item.overCeiling === true).length,
			pendingAfterBreach,
			recycledResults: [fresh, next].filter((item) => item.recycled === true).length,
			pendingAfterRecycle: policy.recyclePending,
			uncollectedOverCeiling: uncollected.overCeiling === true,
			uncollectedPending,
		};
		const manager = new EvalDetachedCellManager({ now: () => 0 });
		try {
			for (let index = 0; index < 40; index += 1) {
				const cell = manager.create(`retained-${index}`, { language, code: String(index), summary: "retention fixture" });
				manager.markRunning(cell);
				const result: AgentToolResult<EvalToolDetails> = {
					content: [{ type: "text", text: `value-${index}` }],
					details: { language, languages: [language], summary: "retention fixture", durationMs: 0, toolCalls: [], truncated: false },
				};
				manager.complete(cell, result);
			}
			const retained = manager.list().recent;
			invariants[`${language}/retentionPolicy`] = {
				retained: retained.length,
				evicted: 40 - retained.length,
				first: retained[0]?.cellId,
				last: retained.at(-1)?.cellId,
				live: manager.list().live.length,
			};
		} finally {
			await manager.dispose();
		}
	}
	return invariants;
}
