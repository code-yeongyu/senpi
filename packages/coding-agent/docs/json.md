# JSON Event Stream Mode

```bash
senpi --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating senpi into other tools or custom UIs.

## Event Types

Wire events use `JsonAgentSessionEvent`. It matches
[`AgentSessionEvent`](../src/core/agent-session.ts)
except that streaming message updates omit cumulative snapshots:

```typescript
type AgentSessionEvent =
  // All AgentEvent variants; agent_end additionally carries willRetry: boolean
  | AgentEvent
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_progress"; reason: "manual" | "threshold" | "overflow"; delta?: string; text?: string }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; requestId?: string; accepted?: boolean; rejectionCause?: "cancelled-by-extension" | "external-owner" | "would-overflow" | "circuit-breaker" | "per-turn-cap"; errorMessage?: string }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
  | SystemPromptChangeEvent           // type: "system_prompt_change"
  | ExtensionToolHookLifecycleEvent   // type: "tool_hook_status"
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "branchSummary" }
  | { type: "summarization_retry_attempt_start"; source: "compaction"; reason: "manual" | "threshold" | "overflow" }
  | { type: "summarization_retry_finished" };
```

`external-owner` means senpi declined the compaction because the active provider owns compaction for the session.

The wire format strips cumulative snapshots from streaming updates:

```typescript
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type JsonAgentSessionEvent =
  | Exclude<AgentSessionEvent, { type: "message_update" }>
  | {
      type: "message_update";
      usage: Usage;
      assistantMessageEvent: WithoutPartial<AssistantMessageEvent>;
    };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start`, `compaction_progress`, and `compaction_end` cover both manual and automatic compaction. `session_info_changed` fires when the session display name changes, `thinking_level_changed` when the thinking level changes, `system_prompt_change` (see `SystemPromptChangeEvent` in [`extensions/types.ts`](../src/core/extensions/types.ts)) when a model switch changes the active system prompt, and `tool_hook_status` (see `ExtensionToolHookLifecycleEvent` in [`extensions/runner.ts`](../src/core/extensions/runner.ts)) for extension tool hook start/end phases.

Other base events come from
[`AgentEvent`](../../agent/src/types.ts):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }  // in JSON mode also: willRetry: boolean
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](../../ai/src/types.ts):
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Extended messages from [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts):
- `BashExecutionMessage`
- `CustomMessage`
- `BranchSummaryMessage`
- `CompactionSummaryMessage`

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

`message_update` records are delta-only. They omit both the cumulative `message` field and
`assistantMessageEvent.partial` to keep stream size linear. The top-level `usage` field contains
the latest cumulative provider-reported usage and may remain zero when a provider only reports
usage at completion. Use `contentIndex` and `delta` to assemble live text, thinking, or tool-call
arguments if needed. `message_end` contains the final authoritative message.

## Example

```bash
senpi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
