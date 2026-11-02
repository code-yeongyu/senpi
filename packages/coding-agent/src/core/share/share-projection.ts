/**
 * What `/share` uploads by default (#3524): the conversation (user and assistant
 * text, tool names and tool-call arguments), never what tools returned. Tool
 * results, `!` command output, extension messages, extension state and data,
 * and context-edit replacements are replaced by a one-line note unless the user
 * explicitly includes tool outputs in the preview. Redaction still runs over
 * everything that is shared.
 *
 * The projection trusts nothing it finds in the data: every output-bearing record
 * is rewritten on every pass, so text that merely looks like a note is replaced
 * too. Each pass counts the outputs it replaced; the caller keeps the largest
 * count across passes, so outputs that share a timestamp are each counted.
 */

export interface OutputOmissions {
	count: number;
}

export function newOutputOmissions(): OutputOmissions {
	return { count: 0 };
}

const OMITTED_RESULT_HTML = ["resultHtmlCollapsed", "resultHtmlExpanded"] as const;

function note(label: string): { type: "text"; text: string } {
	return { type: "text", text: `[output omitted: ${label}]` };
}

function omit(omissions: OutputOmissions): void {
	omissions.count++;
}

function projectRecord(
	record: Record<string, unknown>,
	omissions: OutputOmissions,
): Record<string, unknown> | undefined {
	if (record.role === "toolResult") {
		omit(omissions);
		const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
		return { ...record, content: [note(toolName)], details: undefined };
	}
	if (record.role === "bashExecution") {
		omit(omissions);
		return { ...record, output: "[output omitted: command]", fullOutputPath: undefined };
	}
	if (record.role === "custom" || record.type === "custom_message") {
		omit(omissions);
		const customType = typeof record.customType === "string" ? record.customType : "extension";
		return { ...record, content: [note(customType)], details: undefined };
	}
	if (record.type === "custom") return { ...record, data: undefined };
	if (record.type === "compaction") return { ...record, details: undefined, systemMessage: undefined };
	if (record.type === "branch_summary") return { ...record, details: undefined };
	if (record.type === "context_edit" && record.replacement !== null && typeof record.replacement === "object") {
		omit(omissions);
		return { ...record, replacement: { content: [note("context edit")] } };
	}
	return undefined;
}

function projectRenderedTools(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([id, rendered]) => {
			if (rendered === null || typeof rendered !== "object") return [id, rendered];
			const kept = Object.entries(rendered).filter(
				([key]) => !OMITTED_RESULT_HTML.some((omitted) => omitted === key),
			);
			return [id, Object.fromEntries(kept)];
		}),
	);
}

export function omitToolOutputs<T>(value: T, omissions: OutputOmissions): T {
	return project(value, omissions) as T;
}

function project(value: unknown, omissions: OutputOmissions): unknown {
	if (Array.isArray(value)) return value.map((item) => project(item, omissions));
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const projected = projectRecord(record, omissions);
	if (projected) return projected;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		out[key] = key === "renderedTools" ? projectRenderedTools(child) : project(child, omissions);
	}
	return out;
}
