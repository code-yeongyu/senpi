import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type SessionEntry, type SessionHeader, SessionManager } from "../../src/core/session-manager.ts";

/** Synthetic history only: earlier selections exist on disk but may be unreachable. */
export function writeResumeEffortFixture(
	directory: string,
	options: { provider?: string; modelId?: string; effort?: string; intact?: boolean } = {},
): SessionManager {
	const timestamp = "2026-09-01T00:00:00.000Z";
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: "00000000-0000-4000-8000-000000000001",
		timestamp,
		cwd: directory,
	};
	const entries: SessionEntry[] = [
		{ type: "thinking_level_change", id: "baseline", parentId: null, timestamp, thinkingLevel: "medium" },
		{ type: "thinking_level_change", id: "selection", parentId: "baseline", timestamp, thinkingLevel: "xhigh" },
		{
			type: "thinking_level_change",
			id: "other-branch",
			parentId: "baseline",
			timestamp,
			thinkingLevel: "max",
		},
		{
			type: "message",
			id: "reply",
			parentId: options.intact ? "selection" : "missing-parent",
			timestamp,
			message: {
				...fauxAssistantMessage("SYNTHETIC_HISTORY", { timestamp: 1 }),
				provider: options.provider ?? "openai-codex",
				model: options.modelId ?? "gpt-6-astra",
			},
		},
		{
			type: "configuration_update",
			id: "configuration",
			parentId: "reply",
			timestamp,
			reasoning: { effort: options.effort ?? "xhigh" },
		},
		{
			type: "message",
			id: "prompt",
			parentId: "configuration",
			timestamp,
			message: { role: "user", content: "SYNTHETIC_PROMPT", timestamp: 2 },
		},
	];
	const path = join(directory, "resume-effort.jsonl");
	writeFileSync(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return SessionManager.open(path);
}
