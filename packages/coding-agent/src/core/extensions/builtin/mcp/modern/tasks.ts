import type { MrtrInputResponse } from "./elicitation.ts";
import { McpMrtrError } from "./errors.ts";
import { isRecord } from "./form-schema.ts";
import { parseInputs } from "./inputs.ts";
import { mcpAbortableDelay, mcpInterrupted, type McpClock } from "../wrap.ts";

export const MCP_TASK_EXTENSION = "io.modelcontextprotocol/tasks";
export const MCP_TASK_TIMEOUT_ENV = "SENPI_MCP_TASK_TIMEOUT_MS";
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;

export function mcpTaskTimeoutMs(): number {
	const raw = process.env[MCP_TASK_TIMEOUT_ENV]?.trim();
	if (raw === undefined || raw === "") return DEFAULT_TASK_TIMEOUT_MS;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
		throw new Error(`${MCP_TASK_TIMEOUT_ENV} must be a positive integer no greater than 2147483647.`);
	return value;
}

interface Task extends Record<string, unknown> {
	taskId: string;
	status: "working" | "input_required" | "completed" | "cancelled" | "failed";
	pollIntervalMs?: number;
}

function parseTask(value: Record<string, unknown>, id?: string): Task {
	if (
		typeof value.taskId !== "string" ||
		value.taskId.length === 0 ||
		(id !== undefined && value.taskId !== id) ||
		!["working", "input_required", "completed", "cancelled", "failed"].includes(String(value.status)) ||
		typeof value.createdAt !== "string" ||
		typeof value.lastUpdatedAt !== "string" ||
		(value.ttlMs !== null && (!Number.isSafeInteger(value.ttlMs) || Number(value.ttlMs) < 0)) ||
		(value.pollIntervalMs !== undefined &&
			(!Number.isSafeInteger(value.pollIntervalMs) || Number(value.pollIntervalMs) < 0)) ||
		(value.statusMessage !== undefined && typeof value.statusMessage !== "string")
	)
		throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
	return value as Task;
}

/** Polling belongs to the originating request, never to the shared physical client. */
export async function followMcpTask(
	initial: Record<string, unknown>,
	options: {
		clock: McpClock;
		signal: AbortSignal;
		timeoutMs: number;
		send: (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
		inputs: (result: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, MrtrInputResponse>>;
		progress: (task: { taskId: string; status: string; statusMessage?: string }) => void;
	},
): Promise<Record<string, unknown>> {
	let task = parseTask(initial);
	const id = task.taskId;
	const cap = new AbortController();
	const timeoutError = new McpMrtrError("MCP_TASK_TIMEOUT", undefined, id);
	const deadline = options.clock.now() + options.timeoutMs;
	const timer = options.clock.schedule(() => cap.abort(timeoutError), options.timeoutMs);
	const signal = AbortSignal.any([options.signal, cap.signal]);
	const answered = new Set<string>();
	let terminal = false;
	let backoff = 1000;
	try {
		for (;;) {
			signal.throwIfAborted();
			if (task.status === "completed") {
				if (!isRecord(task.result)) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
				terminal = true;
				return task.result;
			}
			if (task.status === "failed") {
				if (!isRecord(task.error) || !Number.isInteger(task.error.code) || typeof task.error.message !== "string")
					throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
				terminal = true;
				throw new McpMrtrError("MCP_TASK_FAILED", Number(task.error.code), id);
			}
			if (task.status === "cancelled") {
				terminal = true;
				throw new McpMrtrError("MCP_TASK_CANCELLED", undefined, id);
			}
			options.progress({
				taskId: id,
				status: task.status,
				...(typeof task.statusMessage === "string" ? { statusMessage: task.statusMessage } : {}),
			});
			// CreateTaskResult is only the seed; inputRequests are authoritative on tasks/get.
			if (task.status === "input_required" && task.resultType !== "task") {
				parseInputs({ inputRequests: task.inputRequests });
				if (!isRecord(task.inputRequests)) throw new McpMrtrError("MCP_MRTR_INVALID_INPUT");
				const outstanding = Object.fromEntries(
					Object.entries(task.inputRequests).filter(([key]) => !answered.has(key)),
				);
				if (Object.keys(outstanding).length > 0) {
					const responses = await mcpInterrupted(options.inputs({ inputRequests: outstanding }, signal), signal);
					signal.throwIfAborted();
					await options.send("tasks/update", { taskId: id, inputResponses: responses }, signal);
					for (const key of Object.keys(outstanding)) answered.add(key);
				}
			}
			await mcpAbortableDelay(
				options.clock,
				Math.min(task.pollIntervalMs ?? backoff, deadline - options.clock.now()),
				signal,
			);
			const result = await options.send("tasks/get", { taskId: id }, signal);
			if (result.resultType !== undefined && result.resultType !== "complete")
				throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
			task = parseTask(result, id);
			backoff = Math.min(30_000, backoff * 2);
		}
	} catch (error) {
		// A changed owner/credential must never send a task operation with somebody else's authority.
		if (!terminal && !(error instanceof McpMrtrError && error.code === "MCP_MRTR_CONTEXT_CHANGED")) {
			try {
				await options.send("tasks/cancel", { taskId: id });
			} catch {
				// Cancellation is cooperative; retain the original failure even if disconnected.
			}
		}
		if (cap.signal.aborted) throw timeoutError;
		throw error;
	} finally {
		options.clock.cancel(timer);
		answered.clear();
	}
}
