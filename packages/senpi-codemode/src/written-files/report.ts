import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { EvalToolDetails, EvalWrittenFilesDetails } from "../tool/types.ts";
import type { ScanSkipReason } from "./workspace-scan.ts";
import type { WrittenFilesReport } from "./write-hooks.ts";

export type CellWrittenFilesOutcome =
	| { readonly kind: "written"; readonly report: WrittenFilesReport; readonly hooksAvailable: boolean }
	| { readonly kind: "unchecked"; readonly reason: ScanSkipReason; readonly disabled: boolean }
	| { readonly kind: "failed"; readonly message: string };

export function withWrittenFiles(
	result: AgentToolResult<EvalToolDetails>,
	outcome: CellWrittenFilesOutcome | undefined,
): AgentToolResult<EvalToolDetails> {
	if (outcome === undefined) return result;
	const firstImage = result.content.findIndex((part) => part.type === "image");
	const at = firstImage === -1 ? result.content.length : firstImage;
	return {
		...result,
		content: [
			...result.content.slice(0, at),
			{ type: "text", text: writtenFilesText(outcome) },
			...result.content.slice(at),
		],
		details: { ...result.details, writtenFiles: writtenFilesDetails(outcome) },
	};
}

function writtenFilesText(outcome: CellWrittenFilesOutcome): string {
	if (outcome.kind === "failed") return `Files written during this cell were not checked: ${outcome.message}`;
	if (outcome.kind === "unchecked") {
		const off = outcome.disabled ? " The check is off for the rest of this session." : "";
		return `Files written during this cell were not checked: ${skipReasonText(outcome.reason)}.${off}`;
	}
	const { report } = outcome;
	const unlisted = report.total - report.files.length;
	return [
		`Workspace files written during this cell (${report.total}), ${hookedPhrase(outcome)}:`,
		...report.files.map((path) => `- ${path}`),
		...(unlisted === 0 ? [] : [`- (${unlisted} more, not listed and not sent through the write hooks)`]),
		...report.hookOutputs.map((output) => `[write hooks] ${output.path}\n${output.text}`),
		...report.hookFailures.map((failure) => `[write hook failed] ${failure.path}: ${failure.error}`),
	].join("\n");
}

function skipReasonText(reason: ScanSkipReason): string {
	if (reason === "git_unavailable") return "git is not available";
	return reason === "over_budget" ? "the workspace scan went over its budget" : "the workspace scan failed";
}

function hookedPhrase(outcome: Extract<CellWrittenFilesOutcome, { kind: "written" }>): string {
	if (!outcome.hooksAvailable) return "which this host cannot send through the write hooks";
	const { hooked, files } = outcome.report;
	if (hooked === files.length) return "sent through the write hooks";
	return `${hooked} of them sent through the write hooks`;
}

function writtenFilesDetails(outcome: CellWrittenFilesOutcome): EvalWrittenFilesDetails {
	if (outcome.kind !== "written")
		return { files: [], total: 0, hooked: 0, unchecked: outcome.kind === "failed" ? "check_failed" : outcome.reason };
	const { files, total, hooked, hookFailures } = outcome.report;
	return { files, total, hooked, ...(hookFailures.length === 0 ? {} : { hookFailures }) };
}
