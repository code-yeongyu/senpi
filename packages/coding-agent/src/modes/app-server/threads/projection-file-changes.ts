import type { FileUpdateChange, PatchChangeKind } from "../protocol/index.ts";
import type { WireItem } from "./turn-log.ts";

export type FileChangeProjection = {
	readonly item: WireItem;
	readonly diff: string;
};

export function fileChangeProjection(input: {
	readonly id: string;
	readonly name: string;
	readonly args: unknown;
	readonly status: "inProgress" | "completed" | "failed";
	readonly result: unknown;
}): FileChangeProjection {
	const changes = input.status === "inProgress" ? [] : fileChanges(input.name, input.args, input.result);
	return {
		item: { type: "fileChange", id: input.id, changes, status: input.status },
		diff: changes.map((change) => change.diff).join(""),
	};
}

function fileChanges(name: string, args: unknown, result: unknown): readonly FileUpdateChange[] {
	if (!isRecord(result) || !isRecord(result.details)) return [];
	const previewChanges = changesFromPreview(result.details.preview);
	if (previewChanges.length > 0) return previewChanges;
	const patch = normalizedPatch(result.details.patch);
	const path = isRecord(args) ? (readString(args.path) ?? readString(args.file_path)) : undefined;
	if ((name !== "edit" && name !== "write") || !path || !patch) return [];
	const operation =
		readOperation(result.details.operation) ?? (patch.startsWith("--- /dev/null\n") ? "add" : "update");
	const kind = patchChangeKind(operation, null);
	return [{ path, kind, diff: patch }];
}

function changesFromPreview(value: unknown): readonly FileUpdateChange[] {
	if (!isRecord(value) || !Array.isArray(value.files)) return [];
	return value.files.flatMap((file) => {
		if (!isRecord(file)) return [];
		const path = readString(file.filePath);
		const operation = readOperation(file.operation);
		const kind = operation ? patchChangeKind(operation, readString(file.movePath) ?? null) : undefined;
		const diff = normalizedPatch(file.patch);
		return path && kind && diff ? [{ path, kind, diff }] : [];
	});
}

function normalizedPatch(value: unknown): string | undefined {
	const patch = readString(value);
	if (!patch) return undefined;
	return patch.endsWith("\n") ? patch : `${patch}\n`;
}

function readOperation(value: unknown): "add" | "delete" | "update" | undefined {
	switch (value) {
		case "add":
		case "delete":
		case "update":
			return value;
		default:
			return undefined;
	}
}

function patchChangeKind(operation: "add" | "delete" | "update", movePath: string | null): PatchChangeKind {
	switch (operation) {
		case "add":
			return { type: "add" };
		case "delete":
			return { type: "delete" };
		case "update":
			return { type: "update", move_path: movePath };
		default: {
			const exhaustive: never = operation;
			return exhaustive;
		}
	}
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
