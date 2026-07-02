import type { RegistryConnection } from "../rpc/registry.ts";

type JsonObject = { readonly [key: string]: unknown };

export function objectValue(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return Object.assign<Record<string, unknown>, object>({}, value);
}

export function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid params: ${name} is required`);
	}
	return value;
}

export function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function connectionId(connection: RegistryConnection): string {
	const id = Reflect.get(connection, "id");
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("Connection id is required for thread lifecycle methods");
	}
	return id;
}

export function encodeCursor(offset: number): string {
	return Buffer.from(String(offset), "utf8").toString("base64");
}

export function decodeCursor(cursor: string | null): number {
	if (!cursor) {
		return 0;
	}
	const parsed = Number.parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
