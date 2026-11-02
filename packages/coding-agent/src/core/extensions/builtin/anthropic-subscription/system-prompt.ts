import { readFileSync } from "node:fs";
import { overrideSystemPromptGuidance } from "./guidance.ts";

// Measured CLI behavior joins system-prompt arrays into one block and ignores the SDK sentinel,
// so emitting a boundary only pollutes the model prompt with literal garbage.
export function resolveCustomSystemPrompt(prompt: string | undefined): string {
	return prompt ?? "";
}

export function loadOverrideSystemPrompt(path: string | undefined): string {
	if (path === undefined) {
		throw new Error(overrideSystemPromptGuidance(undefined, "the path is not configured"));
	}
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (error: unknown) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(overrideSystemPromptGuidance(path, reason));
	}
	if (content.trim().length === 0) {
		throw new Error(overrideSystemPromptGuidance(path, "the file is empty"));
	}
	return resolveCustomSystemPrompt(content);
}
