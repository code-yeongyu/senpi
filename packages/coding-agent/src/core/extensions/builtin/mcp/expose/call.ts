import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolCatalogEntry } from "../catalog.ts";
import { ToolExecError } from "../errors.ts";
import { ensureMcpToolCallConnection, withMcpRetriableFailedSendRetry, withMcpSessionExpiryRetry } from "../health.ts";
import { runMcpConnectionLifecycleCall } from "../idle.ts";
import type { McpInvocation, McpInvocationError } from "../invocation.ts";
import type { McpToolDefinition } from "./register.ts";

export async function callMcpTool(
	entry: McpToolCatalogEntry,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: Parameters<McpToolDefinition["execute"]>[3],
	label: string,
	invocation: McpInvocation | undefined,
): Promise<
	| {
			kind: "called";
			entry: McpToolCatalogEntry;
			result: Awaited<ReturnType<McpToolCatalogEntry["connection"]["client"]["callTool"]>>;
	  }
	| { kind: "refused"; error: McpInvocationError }
> {
	try {
		return await runMcpConnectionLifecycleCall(entry.connection, () =>
			withMcpSessionExpiryRetry(entry.connection, async () => {
				if (entry.invocation === undefined) {
					await ensureMcpToolCallConnection(entry.connection, entry.ensureFresh);
					await entry.ensureConnected?.();
				}
				const prepare = async () => {
					for (;;) {
						const prepared = await entry.invocation?.resolve(entry, args, invocation, signal);
						if (prepared === undefined || prepared.kind === "refused" || prepared.isCurrent()) {
							return prepared;
						}
					}
				};
				// Readiness and its bounded renewal are not failed remote sends.
				// Only a call attempt below enters the existing failed-send retry.
				let next = await prepare();
				return await withMcpRetriableFailedSendRetry(entry.connection, async () => {
					for (;;) {
						const prepared = next ?? (await prepare());
						next = undefined;
						if (prepared?.kind === "refused") return prepared;
						if (prepared !== undefined && !prepared.isCurrent()) continue;
						const current = prepared?.entry ?? entry;
						const result = await current.connection.client.callTool(
							{ name: current.tool, arguments: args },
							undefined,
							{
								onprogress: (progress) => {
									onUpdate?.({
										content: [{ type: "text", text: formatProgress(label, progress) }],
										details: { progress, server: entry.server, tool: entry.tool },
									});
								},
								signal,
								timeout: current.requestTimeoutMs,
							},
						);
						return { kind: "called" as const, entry: current, result };
					}
				});
			}),
		);
	} catch (error) {
		const label = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		throw new ToolExecError(`ToolExecError: ${label}`, {
			cause: error,
			phase: "call",
			serverName: entry.server,
		});
	}
}

function formatProgress(label: string, progress: Progress): string {
	const total = progress.total === undefined ? "" : `/${progress.total}`;
	const message = progress.message === undefined ? "" : ` ${progress.message}`;
	return `${label} progress ${progress.progress}${total}${message}`.trim();
}
