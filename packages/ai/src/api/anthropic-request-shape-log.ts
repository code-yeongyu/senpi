/** Debug-only request skeleton: roles, block types and tool ids per index, never content (senpi#3727). */
export const REQUEST_SHAPE_LOG_ENV = "SENPI_DEBUG_REQUEST_SHAPE";

interface BlockSkeleton {
	readonly type: string;
	readonly id?: string;
	readonly toolUseId?: string;
}

interface MessageSkeleton {
	readonly index: number;
	readonly role: string;
	readonly blocks: readonly BlockSkeleton[] | "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function skeletonBlock(block: unknown): BlockSkeleton {
	if (!isRecord(block)) return { type: typeof block };
	const type = typeof block.type === "string" ? block.type : "unknown";
	return {
		type,
		...(typeof block.id === "string" ? { id: block.id } : {}),
		...(typeof block.tool_use_id === "string" ? { toolUseId: block.tool_use_id } : {}),
	};
}

export function anthropicRequestSkeleton(params: { readonly messages?: unknown }): MessageSkeleton[] {
	const messages = Array.isArray(params.messages) ? params.messages : [];
	return messages.map((message: unknown, index) => {
		if (!isRecord(message)) return { index, role: "unknown", blocks: [] };
		const role = typeof message.role === "string" ? message.role : "unknown";
		const blocks = Array.isArray(message.content) ? message.content.map(skeletonBlock) : ("string" as const);
		return { index, role, blocks };
	});
}

type AppendFile = (path: string, data: string) => void;

function resolveAppendFile(): AppendFile | undefined {
	if (typeof process === "undefined") return undefined;
	const fs = process.getBuiltinModule?.("node:fs");
	return fs ? (path, data) => fs.appendFileSync(path, data, { mode: 0o600 }) : undefined;
}

function processEnv(): Readonly<Record<string, string | undefined>> {
	return typeof process === "undefined" ? {} : process.env;
}

export function logAnthropicRequestShape(
	model: { readonly provider: string; readonly id: string },
	params: { readonly messages?: unknown },
	env: Readonly<Record<string, string | undefined>> = processEnv(),
	appendFile: AppendFile | undefined = undefined,
): void {
	const path = env[REQUEST_SHAPE_LOG_ENV];
	if (path === undefined || path.length === 0) return;
	const append = appendFile ?? resolveAppendFile();
	if (append === undefined) return;
	const record = {
		ts: new Date().toISOString(),
		provider: model.provider,
		model: model.id,
		messages: anthropicRequestSkeleton(params),
	};
	append(path, `${JSON.stringify(record)}\n`);
}
