import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "../types.js";

export interface TpsTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

interface TpsSnapshot {
	messageCount: number;
	totals: TpsTotals;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

function emptyTotals(): TpsTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export function collectTpsTotals(messages: readonly unknown[]): TpsTotals {
	const totals = emptyTotals();

	for (const message of messages) {
		if (!isAssistantMessage(message)) continue;
		totals.input += message.usage.input || 0;
		totals.output += message.usage.output || 0;
		totals.cacheRead += message.usage.cacheRead || 0;
		totals.cacheWrite += message.usage.cacheWrite || 0;
		totals.totalTokens += message.usage.totalTokens || 0;
	}

	return totals;
}

function totalsAreAtLeast(current: TpsTotals, previous: TpsTotals): boolean {
	return (
		current.input >= previous.input &&
		current.output >= previous.output &&
		current.cacheRead >= previous.cacheRead &&
		current.cacheWrite >= previous.cacheWrite &&
		current.totalTokens >= previous.totalTokens
	);
}

function subtractTotals(current: TpsTotals, previous: TpsTotals): TpsTotals {
	return {
		input: current.input - previous.input,
		output: current.output - previous.output,
		cacheRead: current.cacheRead - previous.cacheRead,
		cacheWrite: current.cacheWrite - previous.cacheWrite,
		totalTokens: current.totalTokens - previous.totalTokens,
	};
}

export function calculateTpsDelta(current: TpsSnapshot, previous: TpsSnapshot | undefined): TpsTotals {
	if (previous && current.messageCount > previous.messageCount && totalsAreAtLeast(current.totals, previous.totals)) {
		return subtractTotals(current.totals, previous.totals);
	}

	return current.totals;
}

export function formatTpsMessage(delta: TpsTotals, elapsedSeconds: number): string {
	const tokensPerSecond = delta.output / elapsedSeconds;
	return `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${delta.output.toLocaleString()}, in ${delta.input.toLocaleString()}, cache r/w ${delta.cacheRead.toLocaleString()}/${delta.cacheWrite.toLocaleString()}, total ${delta.totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`;
}

export default function (pi: ExtensionAPI) {
	let agentStartMs: number | null = null;
	let lastSnapshot: TpsSnapshot | undefined;

	pi.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	pi.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		const currentSnapshot = { messageCount: event.messages.length, totals: collectTpsTotals(event.messages) };
		const delta = calculateTpsDelta(currentSnapshot, lastSnapshot);
		lastSnapshot = currentSnapshot;

		if (delta.output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const message = formatTpsMessage(delta, elapsedSeconds);
		ctx.ui.notify(message, "info");
	});
}
