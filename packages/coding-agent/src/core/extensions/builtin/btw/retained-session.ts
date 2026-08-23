import { SESSION_TOOL_POLICY_ENTRY_TYPE, type SessionToolPolicy } from "../../../session-tool-policy.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../types.ts";
import {
	BTW_SIDE_ENTRY_TYPE,
	type BtwSessionCatalog,
	type BtwSideMetadata,
	readBtwSideMetadata,
} from "./session-catalog.ts";
import { SIDE_QUERY_INSTRUCTION } from "./side-query.ts";

export interface CreateRetainedBtwSideInput {
	ctx: ExtensionCommandContext;
	catalog: BtwSessionCatalog;
	question: string | undefined;
	parentContext: string;
	now?: () => Date;
}

const BTW_PARENT_CONTEXT_ENTRY_TYPE = "btw-parent-context";
const MAX_SUMMARY_CHARACTERS = 72;

export function applyBtwSideSessionPolicy(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	if (!readBtwSideMetadata(ctx.sessionManager.getEntries())) return false;
	pi.setActiveTools([]);
	return true;
}

export function nextBtwOrdinal(catalog: BtwSessionCatalog): number {
	return Math.max(0, ...catalog.sides.map((side) => side.metadata.ordinal)) + 1;
}

export function summarizeBtwQuestion(question: string | undefined): string {
	const safe = Array.from(question ?? "", (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 32 || codePoint === 127 ? " " : character;
	}).join("");
	const normalized = safe.replace(/\s+/g, " ").trim();
	if (!normalized) return "New BTW";
	const characters = Array.from(normalized);
	return characters.length <= MAX_SUMMARY_CHARACTERS
		? normalized
		: `${characters.slice(0, MAX_SUMMARY_CHARACTERS - 1).join("")}…`;
}

export async function createRetainedBtwSide(input: CreateRetainedBtwSideInput): Promise<void> {
	await input.ctx.waitForIdle();
	const question = input.question?.trim() || undefined;
	const ordinal = nextBtwOrdinal(input.catalog);
	const summary = summarizeBtwQuestion(question);
	const createdAt = (input.now ?? (() => new Date()))().toISOString();
	const metadata: BtwSideMetadata = {
		version: 1,
		parentSessionPath: input.catalog.parentSessionPath,
		parentSessionId: input.catalog.currentSide?.metadata.parentSessionId ?? input.ctx.sessionManager.getSessionId(),
		ordinal,
		summary,
		createdAt,
	};
	const name = `BTW #${ordinal}: ${summary}`;
	const model = input.ctx.model;
	const thinkingLevel = input.ctx.thinkingLevel;

	await input.ctx.newSession({
		parentSession: input.catalog.parentSessionPath,
		setup: async (sessionManager) => {
			sessionManager.appendCustomEntry(BTW_SIDE_ENTRY_TYPE, metadata);
			sessionManager.appendCustomEntry(SESSION_TOOL_POLICY_ENTRY_TYPE, {
				version: 1,
				tools: "disabled",
			} satisfies SessionToolPolicy);
			sessionManager.appendSessionInfo(name);
			sessionManager.appendCustomMessageEntry(
				BTW_PARENT_CONTEXT_ENTRY_TYPE,
				[
					SIDE_QUERY_INSTRUCTION,
					"",
					"Context from Main at creation time:",
					input.parentContext || "(No prior messages.)",
				].join("\n"),
				false,
				metadata,
			);
		},
		withSession: async (nextCtx) => {
			nextCtx.setActiveTools([]);
			if (model && !(await nextCtx.setSessionModel(model))) {
				throw new Error(`Unable to restore BTW model ${model.provider}/${model.id}`);
			}
			if (thinkingLevel) nextCtx.setSessionThinkingLevel(thinkingLevel);
			if (question) {
				await nextCtx.sendUserMessage(question, {
					expandPromptTemplates: false,
				});
			}
		},
	});
}
