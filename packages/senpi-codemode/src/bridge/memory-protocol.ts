import { type Static, Type } from "typebox";

/** Host -> kernel (`init`): byte thresholds for post-cell collection, the large-globals notice, and the ceiling; 0 disables each. */
export const kernelMemoryThresholdsSchema = Type.Object({
	gcWatermarkBytes: Type.Integer({ minimum: 0 }),
	noticeBytes: Type.Integer({ minimum: 0 }),
	ceilingBytes: Type.Integer({ minimum: 0 }),
});

const kernelMemoryGlobalSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	bytes: Type.Integer({ minimum: 0 }),
	approximate: Type.Optional(Type.Boolean()),
});

/**
 * Kernel -> host memory report carried on the `result` frame. The kernel sets `liveBytes`, `measure`,
 * `gcRan`, and `globals`; the kernel host adds `overCeiling`, `recycled`, and the `notice` text.
 */
export const kernelMemoryReportSchema = Type.Object({
	liveBytes: Type.Integer({ minimum: 0 }),
	measure: Type.Union([Type.Literal("heap"), Type.Literal("footprint")]),
	/** `liveBytes` is a peak-RSS fallback (no footprint counter on this platform), not the current size. */
	approximate: Type.Optional(Type.Boolean()),
	/** `liveBytes` was measured right after a full collection in this cell. */
	gcRan: Type.Optional(Type.Boolean()),
	/** Largest user globals, measured only when live memory after collection reached the notice threshold. */
	globals: Type.Optional(Type.Array(kernelMemoryGlobalSchema, { maxItems: 8 })),
	/** Host-set: live memory after collection reached the ceiling; the kernel restarts once its queue drains. */
	overCeiling: Type.Optional(Type.Boolean()),
	/** Host-set: this is the first result on a kernel that was restarted for exceeding the ceiling. */
	recycled: Type.Optional(Type.Boolean()),
	/** Host-set: the bracketed notice shown to the model as its own text part. */
	notice: Type.Optional(Type.String()),
});

/** On-demand heap reading between cells (JS kernels): no cell runs and no collection is forced. */
export const kernelMemoryQueryHostToKernelSchemas = [
	Type.Object({ type: Type.Literal("memory-query"), requestId: Type.String({ minLength: 1 }) }),
] as const;

export const kernelMemoryQueryKernelToHostSchemas = [
	Type.Object({
		type: Type.Literal("memory-query-result"),
		requestId: Type.String({ minLength: 1 }),
		liveBytes: Type.Integer({ minimum: 0 }),
		measure: Type.Literal("heap"),
	}),
] as const;

export type KernelMemoryThresholds = Static<typeof kernelMemoryThresholdsSchema>;
export type KernelMemoryReport = Static<typeof kernelMemoryReportSchema>;
export type KernelMemoryGlobal = Static<typeof kernelMemoryGlobalSchema>;
