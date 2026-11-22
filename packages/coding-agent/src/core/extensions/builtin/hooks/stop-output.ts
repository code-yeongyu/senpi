import type { HookDispatchResult, HookDispatchSummary } from "./dispatcher.ts";
import { diagnostic } from "./diagnostics.ts";
import type { HookDiagnostic } from "./types.ts";

/** What a Stop hook's output set, recorded as a `senpi.hooks.stop-output` entry. */
export type StopOutputRecord = {
	readonly event: "Stop";
	readonly exitCode: number | null;
	readonly fields: readonly string[];
	readonly sourcePath: string;
};

export function stopOutputRecords(result: HookDispatchResult): readonly StopOutputRecord[] {
	return result.summaries.flatMap((summary) => {
		const fields = stopOutputFieldPaths(summary);
		if (fields.length === 0) return [];
		return [
			{
				event: "Stop",
				exitCode: summary.run.exitCode,
				fields,
				sourcePath: summary.handler.source.sourcePath,
			},
		];
	});
}

export function unsupportedStopOutputDiagnostics(result: HookDispatchResult): readonly HookDiagnostic[] {
	const diagnostics: HookDiagnostic[] = [];
	for (const summary of result.summaries) {
		diagnostics.push(...unsupportedSummaryDiagnostics(summary));
	}
	return diagnostics;
}

function unsupportedSummaryDiagnostics(summary: HookDispatchSummary): readonly HookDiagnostic[] {
	const diagnostics: HookDiagnostic[] = [];
	if (summary.output.systemMessage !== undefined) {
		diagnostics.push(unsupportedField(summary, "stdout.systemMessage", "Stop does not support systemMessage."));
	}
	if (summary.output.suppressOutput !== undefined) {
		diagnostics.push(unsupportedField(summary, "stdout.suppressOutput", "Stop does not support suppressOutput."));
	}
	if (summary.output.stopReason !== undefined) {
		diagnostics.push(unsupportedField(summary, "stdout.stopReason", "Stop output stopReason is diagnostic-only."));
	}
	if (summary.output.updatedInput !== undefined) {
		diagnostics.push(unsupportedField(summary, "stdout.updatedInput", "Stop does not support updatedInput."));
	}
	if (summary.output.updatedToolOutput !== undefined) {
		diagnostics.push(
			unsupportedField(summary, "stdout.updatedToolOutput", "Stop does not support updatedToolOutput."),
		);
	}
	for (const path of rawUnsupportedStopFieldPaths(summary)) {
		diagnostics.push(unsupportedField(summary, path, `Stop does not support ${path.replace("stdout.", "")}.`));
	}
	return diagnostics;
}

function stopOutputFieldPaths(summary: HookDispatchSummary): readonly string[] {
	const fields: string[] = [];
	if (summary.output.decision !== undefined) fields.push("stdout.decision");
	if (summary.output.reason !== undefined) fields.push("stdout.reason");
	if (summary.output.additionalContext !== undefined) {
		const raw = rawStdoutObject(summary.run.stdout);
		const specific = raw === undefined ? undefined : rawHookSpecificOutput(raw);
		fields.push(
			specific !== undefined && Object.hasOwn(specific, "additionalContext")
				? "stdout.hookSpecificOutput.additionalContext"
				: "stdout.additionalContext",
		);
	}
	if (summary.output.continue !== undefined) fields.push("stdout.continue");
	if (summary.output.stopReason !== undefined) fields.push("stdout.stopReason");
	if (summary.output.suppressOutput !== undefined) fields.push("stdout.suppressOutput");
	if (summary.output.systemMessage !== undefined) fields.push("stdout.systemMessage");
	fields.push(...rawUnsupportedStopFieldPaths(summary));
	return fields;
}

function rawUnsupportedStopFieldPaths(summary: HookDispatchSummary): readonly string[] {
	const raw = rawStdoutObject(summary.run.stdout);
	if (raw === undefined) return [];
	const fields: string[] = [];
	pushFieldIfPresent(fields, raw, "updatedInput", "stdout.updatedInput");
	pushFieldIfPresent(fields, raw, "updatedToolOutput", "stdout.updatedToolOutput");
	const specific = rawHookSpecificOutput(raw);
	if (specific !== undefined) {
		pushFieldIfPresent(fields, specific, "updatedInput", "stdout.hookSpecificOutput.updatedInput");
		pushFieldIfPresent(fields, specific, "updatedToolOutput", "stdout.hookSpecificOutput.updatedToolOutput");
	}
	return fields;
}

function pushFieldIfPresent(
	fields: string[],
	record: Readonly<Record<string, unknown>>,
	key: string,
	path: string,
): void {
	if (Object.hasOwn(record, key)) fields.push(path);
}

function rawStdoutObject(stdout: string): Readonly<Record<string, unknown>> | undefined {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function rawHookSpecificOutput(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
	const value = raw.hookSpecificOutput;
	return isRecord(value) ? value : undefined;
}

function unsupportedField(summary: HookDispatchSummary, path: string, message: string): HookDiagnostic {
	return diagnostic(
		{
			code: "unsupported_field",
			event: "Stop",
			message,
			path,
			severity: "warning",
		},
		summary.handler.source,
	);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
