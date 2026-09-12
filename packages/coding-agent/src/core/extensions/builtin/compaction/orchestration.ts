import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { copyContextProvenance } from "@earendil-works/pi-ai";
import { type CompactionPreparation, estimateTokens } from "../../../compaction/index.ts";
import type { BeforeAgentStartEventResult } from "../../types.ts";
import { type IdleCompactionDecision, shouldWarmAtIdle } from "./idle.ts";
import * as policy from "./policy.ts";
import { isWarmResultStale, isWithinGraceBand, resolveSpeculationLeadTokens } from "./speculation-lead.ts";
import { admitToolResult, admitToolResultWithinBudget, resolveToolResultAdmissionCapTokens } from "./tool-admission.ts";

export interface CompactionGeometry {
	reserveTokens: number;
	thresholdTokens: number;
	leadTokens: number;
}

export function resolveCompactionGeometry(input: {
	contextWindow: number;
	settings: CompactionPreparation["settings"];
	lastYield?: { savedTokens: number; tokensBefore: number };
}): CompactionGeometry {
	const thresholdTokens = input.contextWindow * policy.computeEffectiveThreshold(input.contextWindow, input.lastYield);
	return {
		reserveTokens: policy.resolveEffectiveReserveTokens(input.contextWindow, input.settings),
		thresholdTokens,
		leadTokens: resolveSpeculationLeadTokens(thresholdTokens, input.settings.speculativeLeadTokens),
	};
}

export function shouldDeferGraceBand(input: {
	tokens: number;
	thresholdTokens: number;
	leadTokens: number;
	contextWindow: number;
	reserveTokens: number;
	compactionInFlight: boolean;
	graceBandEnabled?: boolean;
}): boolean {
	return (
		input.compactionInFlight &&
		input.graceBandEnabled !== false &&
		isWithinGraceBand(input.tokens, input.thresholdTokens, input.leadTokens, input.contextWindow, input.reserveTokens)
	);
}

export function injectTokenBudgetReminder(messages: AgentMessage[], reminder?: string): AgentMessage[] {
	if (!reminder) return messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const content =
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const firstPart = content[0];
		if (firstPart?.type === "text" && firstPart.text === reminder) return messages;
		const reminded = copyContextProvenance(message, {
			...message,
			content: [{ type: "text" as const, text: reminder }, ...content],
		});
		return messages.map((candidate, candidateIndex) => (candidateIndex === index ? reminded : candidate));
	}
	return messages;
}

export function resolveBeforeAgentStartMessage(input: {
	message?: BeforeAgentStartEventResult["message"];
	reminder?: string;
	reminderEnabled?: boolean;
}): BeforeAgentStartEventResult["message"] | undefined {
	if (!input.reminder || input.reminderEnabled === false) return input.message;
	if (!input.message) return undefined;
	return { ...input.message, content: `${input.message.content}\n\n${input.reminder}` };
}

export function resolveReminderSystemPrompt(input: {
	systemPrompt: string;
	reminder?: string;
	reminderEnabled?: boolean;
}): string | undefined {
	if (!input.reminder || input.reminderEnabled === false) return undefined;
	return `${input.systemPrompt}\n\n${input.reminder}`;
}

export function resolveIdleWarmAction(
	decision: IdleCompactionDecision,
	job: { armedAtTokens: number } | undefined,
): "none" | "start" | "replace" {
	if (!shouldWarmAtIdle(decision)) return "none";
	if (!job) return "start";
	const currentTokens = decision.usage?.tokens ?? 0;
	return isWarmResultStale(job.armedAtTokens, currentTokens, decision.settings.keepRecentTokens) ? "replace" : "none";
}

export function admitContextToolResult(text: string, contextWindow: number): { text: string; admitted: boolean } {
	const result = admitToolResult({ text, contextWindow });
	return { text: result.text, admitted: result.projected };
}

export function admitContextToolResults(
	messages: AgentMessage[],
	contextWindow: number,
	enabled: boolean,
): AgentMessage[] {
	if (!enabled) return messages;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		if (typeof message.content === "string") {
			const admitted = admitContextToolResult(message.content, contextWindow);
			return admitted.admitted ? { ...message, content: [{ type: "text", text: admitted.text }] } : message;
		}

		const textTokens = message.content.map((part) =>
			part.type === "text" ? estimateTokens({ role: "user", content: part.text, timestamp: 0 }) : 0,
		);
		const totalTextTokens = textTokens.reduce((total, tokens) => total + tokens, 0);
		const capTokens = resolveToolResultAdmissionCapTokens(contextWindow);
		if (totalTextTokens <= capTokens) return message;

		const preservedTokens = textTokens.reduce((total, tokens) => total + (tokens <= capTokens ? tokens : 0), 0);
		const preserveUnderCap = preservedTokens <= capTokens;
		let remainingBudget = preserveUnderCap ? capTokens - preservedTokens : capTokens;
		let remainingOversizedTokens = preserveUnderCap
			? textTokens.reduce((total, tokens) => total + (tokens > capTokens ? tokens : 0), 0)
			: totalTextTokens;
		let projected = false;
		const content = message.content.map((part, index) => {
			if (part.type !== "text") return part;
			const partTokens = textTokens[index] ?? 0;
			if (preserveUnderCap && partTokens <= capTokens) return part;
			const budget = Math.floor((remainingBudget * partTokens) / Math.max(1, remainingOversizedTokens));
			const admitted = admitToolResultWithinBudget(part.text, budget);
			remainingOversizedTokens -= partTokens;
			remainingBudget -= estimateTokens({ role: "user", content: admitted.text, timestamp: 0 });
			if (!admitted.projected) return part;
			projected = true;
			return { ...part, text: admitted.text };
		});
		return projected ? { ...message, content } : message;
	});
}
