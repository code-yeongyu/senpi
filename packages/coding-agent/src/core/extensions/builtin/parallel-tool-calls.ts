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

const PARALLEL_TOOL_CALLS_SECTION = `
## Execution Strategy

### Parallel Tool Calls

When multiple tool calls are independent of each other, fire them ALL in the same turn. Sequential tool calls waste round-trips and slow down every task.

**Always parallelize:**
- Multiple file reads: if you know you need files A, B, and C, read them all at once
- Multiple searches: fire \`grep\` and \`glob\` calls simultaneously for different patterns
- LSP lookups on different symbols: \`lsp_goto_definition\`, \`lsp_find_references\`, \`lsp_diagnostics\` in parallel
- Cross-tool combinations: \`read\` + \`grep\` + \`glob\` + LSP calls together when they gather independent context

**Anticipate what you'll need.** Before calling any tool, ask: "What other context will I need alongside this?" Then gather it all in one turn.

**Anti-pattern:** Reading one file, seeing an import, then reading that file in a new turn. Instead, read the file and its likely dependencies together upfront.

### Context Breadth Before Changes

Before modifying any file, gather enough context to get the change right on the first try:

1. **Read the target file AND its direct imports** - understand the full dependency chain
2. **Find all references to symbols you will change** - know the blast radius
3. **Check for related test files** - know what will break
4. **Read any inline comments or docs explaining design choices** - understand the why

Multiple well-informed edits in one pass beats a cycle of edit-then-fix-then-fix-again.

### Search Strategy

Use the right search tool for each job, and combine them in parallel:

| Goal | Tool | When |
|------|------|------|
| Find text in files | \`grep\` | Content patterns, string literals, error messages |
| Find files by name | \`glob\` | Locating test files, configs, modules by path pattern |
| Find symbol usages | \`lsp_find_references\` | Tracking all call sites before renaming or modifying |
| Find structural patterns | \`ast_grep\` | Matching code shape regardless of variable names |
| Understand a symbol | \`lsp_goto_definition\` | Jump to where something is defined |

When investigating an unfamiliar area, fire 2-4 of these in parallel to build a complete picture fast.
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
