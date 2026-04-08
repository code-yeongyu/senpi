import type { Api } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "../types.js";

type ProviderPayload = Record<string, unknown>;

const OPENAI_PARALLEL_TOOL_CALL_APIS: ReadonlySet<Api> = new Set([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

function isRecord(value: unknown): value is ProviderPayload {
	return typeof value === "object" && value !== null;
}

function hasTools(payload: ProviderPayload): boolean {
	return Array.isArray(payload.tools) && payload.tools.length > 0;
}

export function addParallelToolCallsToPayload(api: Api | undefined, payload: unknown): unknown {
	if (!api || !OPENAI_PARALLEL_TOOL_CALL_APIS.has(api)) {
		return payload;
	}

	if (!isRecord(payload) || !hasTools(payload) || payload.parallel_tool_calls !== undefined) {
		return payload;
	}

	return {
		...payload,
		parallel_tool_calls: true,
	};
}

export const PARALLEL_TOOL_CALLS_SECTION = `
## Execution Strategy

### Parallel Tool Calls

When multiple tool calls are independent, fire them ALL in the same turn. Sequential tool calls waste round-trips and slow down every task.

- Multiple file reads in the same turn when you already know the paths
- Multiple searches with different patterns fired simultaneously
- Combining read operations with search operations when they gather independent context

Before calling any tool, ask: "What other context will I need alongside this?" Then gather it all in one turn.

### Context Breadth Before Changes

Before modifying any file, gather enough context to get the change right on the first try:

1. Read the target file and any files it directly depends on - understand the dependency chain
2. Find every reference to symbols you will change - know the blast radius
3. Check for related tests - know what might break
4. Read inline comments or docs explaining design choices - understand the why

Multiple well-informed edits in one pass beats a cycle of edit-then-fix-then-fix-again.
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		return addParallelToolCallsToPayload(ctx.model?.api, event.payload);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n${PARALLEL_TOOL_CALLS_SECTION}`,
		};
	});
}
