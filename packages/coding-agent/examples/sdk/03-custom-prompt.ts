/**
 * Custom System Prompt
 *
 * Shows how to replace or modify the default system prompt.
 */

import { createAgentSession, SessionManager } from "@code-yeongyu/senpi";

// Note: DefaultResourceLoader no longer supports systemPromptOverride.
// Use system prompt events in extensions or modify APPEND_SYSTEM.md instead.

const { session } = await createAgentSession({
	sessionManager: SessionManager.inMemory(),
});

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

console.log("=== Custom prompt via APPEND_SYSTEM.md ===");
await session.prompt("What is 2 + 2?");
console.log("\n");
