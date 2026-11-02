import { appendFileSync, existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

/** `--list-tools-gate <path>`: record each tools/list request in `<path>.requests`,
 * then hold the reply until the test creates `<path>`. */
export function registerListTools(
	server: Server,
	gate: string | undefined,
	tools: ListToolsResult["tools"],
	nullNextCursor = false,
): void {
	server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
		if (gate !== undefined) await passGate(gate);
		// `--null-next-cursor`: a server that ends pagination with null instead of omitting the cursor.
		if (nullNextCursor) return { tools, nextCursor: null } as unknown as ListToolsResult;
		return { tools };
	});
}

async function passGate(gate: string): Promise<void> {
	appendFileSync(`${gate}.requests`, "tools/list\n");
	await new Promise<void>((resolve) => {
		const watcher = watch(dirname(gate), () => {
			if (!existsSync(gate)) return;
			watcher.close();
			resolve();
		});
		if (!existsSync(gate)) return;
		watcher.close();
		resolve();
	});
}
