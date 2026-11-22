import { memoryReportSessionFor } from "../../core/memory-report/memory-report-registry.ts";
import { writeMemoryReports } from "../../core/memory-report/memory-report-write.ts";

export type MemoryReportAnswer =
	| { readonly ok: true; readonly data: { readonly path: string; readonly heapSnapshot?: string } }
	| { readonly ok: false; readonly error: string };

/** `memory_report`: writes the session's report on demand; refused unless the host runs with SENPI_MEMORY_REPORT=1. */
export async function answerMemoryReport(session: object): Promise<MemoryReportAnswer> {
	const source = memoryReportSessionFor(session);
	if (source === undefined) {
		return { ok: false, error: "memory_report_disabled: start the host with SENPI_MEMORY_REPORT=1" };
	}
	const [outcome] = await writeMemoryReports([source]);
	if (outcome === undefined || !outcome.ok) {
		return {
			ok: false,
			error: `memory_report_failed: ${outcome?.ok === false ? outcome.error : "no report written"}`,
		};
	}
	return {
		ok: true,
		data: {
			path: outcome.path,
			...(outcome.heapSnapshot === undefined ? {} : { heapSnapshot: outcome.heapSnapshot }),
		},
	};
}
