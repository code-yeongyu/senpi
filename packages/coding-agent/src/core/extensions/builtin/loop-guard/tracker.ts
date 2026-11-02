import { TRACK_WINDOW } from "./policy.ts";

export interface ToolCallRecord {
	readonly toolName: string;
	readonly argsJson: string;
	readonly signature: string;
}

export function canonicalizeArgs(args: unknown): string {
	return stableStringify(args ?? {});
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const parts: string[] = [];
	for (const key of keys) {
		const entry = record[key];
		if (entry === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
	}
	return `{${parts.join(",")}}`;
}

export class ToolCallTracker {
	private calls: ToolCallRecord[] = [];

	record(toolName: string, args: unknown): ToolCallRecord {
		const argsJson = canonicalizeArgs(args);
		const record = { toolName, argsJson, signature: `${toolName}\u0000${argsJson}` };
		this.calls.push(record);
		if (this.calls.length > TRACK_WINDOW) {
			this.calls = this.calls.slice(-TRACK_WINDOW);
		}
		return record;
	}

	get records(): readonly ToolCallRecord[] {
		return this.calls;
	}

	reset(): void {
		this.calls = [];
	}
}
