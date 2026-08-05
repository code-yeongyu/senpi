import { atomicTarget, bashFailureStatus, observedBashLines, sanitizeAtomicLabel } from "./atomic-tool-observation.ts";
import type { ToolExecutionIdentity, ToolExecutionRenderState } from "./tool-execution-types.ts";

const PASSTHROUGH_TOOLS = new Set(["monitor", "todo", "create_goal", "get_goal", "update_goal"]);
const STATUS_TOOLS = new Set([
	"task",
	"task_create",
	"task_get",
	"task_list",
	"task_update",
	"team_create",
	"team_delete",
]);

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function plural(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function knownCount(toolName: string, args: unknown, details: unknown): string | undefined {
	const detailFields = record(details);
	const argFields = record(args);
	switch (toolName) {
		case "read": {
			const totalLines = count(record(detailFields?.truncation)?.totalLines);
			return totalLines === undefined ? undefined : plural(totalLines, "line");
		}
		case "lsp_diagnostics": {
			const diagnostics = count(detailFields?.totalDiagnostics);
			return diagnostics === undefined ? undefined : plural(diagnostics, "diagnostic");
		}
		case "lsp_find_references": {
			const references =
				count(detailFields?.totalReferences) ??
				(Array.isArray(detailFields?.references) ? detailFields.references.length : undefined);
			return references === undefined ? undefined : plural(references, "reference");
		}
		case "lsp_symbols": {
			const symbols =
				count(detailFields?.totalSymbols) ??
				(Array.isArray(detailFields?.symbols) ? detailFields.symbols.length : undefined);
			return symbols === undefined ? undefined : plural(symbols, "symbol");
		}
		case "web_search": {
			const results =
				count(detailFields?.totalResults) ??
				(Array.isArray(detailFields?.results) ? detailFields.results.length : undefined);
			return results === undefined ? undefined : plural(results, "result");
		}
		case "multi_tool_use.parallel":
			return Array.isArray(argFields?.tool_uses) ? plural(argFields.tool_uses.length, "call") : undefined;
		case "task":
			return Array.isArray(argFields?.tasks) ? plural(argFields.tasks.length, "task") : undefined;
		case "team_create": {
			const members = record(argFields?.inline_spec)?.members;
			return Array.isArray(members) ? plural(members.length, "member") : undefined;
		}
		default:
			return undefined;
	}
}

function knownStatus(toolName: string, state: ToolExecutionRenderState): string | undefined {
	if (STATUS_TOOLS.has(toolName)) {
		const details = record(state.result?.details);
		const status = typeof details?.status === "string" ? sanitizeAtomicLabel(details.status) : undefined;
		if (status) return status;
		if (state.isPartial) {
			const activity = record(details?.progress)?.activity;
			const partial = details?.phase ?? activity;
			return typeof partial === "string" ? sanitizeAtomicLabel(partial) : undefined;
		}
	}
	return state.result?.isError ? "failed" : undefined;
}

export function isAtomicToolPassthrough(identity: ToolExecutionIdentity): boolean {
	return identity.trustedBuiltIn && PASSTHROUGH_TOOLS.has(identity.toolName);
}

export class AtomicToolMetadata {
	readonly name: string;
	readonly supportsProgressSpinner: boolean;
	target: string | undefined;
	facts: string | undefined;
	isError = false;
	private readonly identity: ToolExecutionIdentity;
	private retainedLines?: number;
	private retainedLinesTruncated = false;
	private retainedCalls?: number;

	constructor(identity: ToolExecutionIdentity, state: ToolExecutionRenderState) {
		this.identity = identity;
		this.name = sanitizeAtomicLabel(identity.toolName);
		this.supportsProgressSpinner =
			identity.trustedBuiltIn && (identity.toolName === "bash" || identity.toolName === "eval");
		this.update(state);
	}

	update(state: ToolExecutionRenderState): void {
		this.target = undefined;
		this.facts = undefined;
		this.isError = false;
		try {
			this.isError = state.result?.isError === true;
			this.target = atomicTarget(this.identity, state.args);
			if (this.identity.trustedBuiltIn && this.identity.toolName === "bash") {
				const observed = observedBashLines(state.result);
				if (observed) {
					if (observed.count > (this.retainedLines ?? 0)) {
						this.retainedLines = observed.count;
						this.retainedLinesTruncated = observed.truncated;
					} else if (observed.truncated) {
						this.retainedLinesTruncated = true;
					}
				}
			} else if (this.identity.trustedBuiltIn && this.identity.toolName === "eval") {
				const calls = record(state.result?.details)?.toolCalls;
				if (Array.isArray(calls)) this.retainedCalls = Math.max(this.retainedCalls ?? 0, calls.length);
			}
			this.facts = this.buildFacts(state);
		} catch {
			this.facts = undefined;
		}
	}

	private buildFacts(state: ToolExecutionRenderState): string | undefined {
		if (this.identity.trustedBuiltIn && this.identity.toolName === "bash" && this.retainedLines !== undefined) {
			const suffix = this.retainedLinesTruncated ? "+" : "";
			const lines = `${this.retainedLines}${suffix} line${this.retainedLines === 1 ? "" : "s"}`;
			return [lines, bashFailureStatus(state.result)].filter(Boolean).join(" · ");
		}
		if (this.identity.trustedBuiltIn && this.identity.toolName === "eval" && this.retainedCalls !== undefined) {
			return plural(this.retainedCalls, "call");
		}
		if (!this.identity.trustedBuiltIn) return this.isError ? "failed" : undefined;
		return (
			[
				knownCount(this.identity.toolName, state.args, state.result?.details),
				knownStatus(this.identity.toolName, state),
			]
				.filter(Boolean)
				.join(" · ") || undefined
		);
	}
}
