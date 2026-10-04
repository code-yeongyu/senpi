/** Cross-kernel bridge names shared by preludes and host adapters. */
/** Canonical oh-my-pi agent bridge tool name. */
export const RESERVED_AGENT_TOOL = "__agent__" as const;
/** ADAPTATION: senpi delegates output through a reserved kernel-side tool name. */
export const RESERVED_OUTPUT_TOOL = "__output__" as const;
/** ADAPTATION: senpi resolves tool parameter schemas through a reserved kernel-side tool name. */
export const RESERVED_SCHEMA_TOOL = "__schema__" as const;
/** In-cell `wait(handles)` barrier over the host's EvalHandleHost subscription capability. */
export const RESERVED_WAIT_TOOL = "__wait__" as const;
/** `handle(node).control.status()`: one epoch-fenced snapshot through the host's `watch`. */
export const RESERVED_HANDLE_STATUS_TOOL = "__handle_status__" as const;
/** `handle(node).control.output(opts)`: the transcript of exactly `ref.run_epoch`. */
export const RESERVED_HANDLE_OUTPUT_TOOL = "__handle_output__" as const;
/** `handle(node).control.send(message)`: agent handles only, fenced inside the task owner. */
export const RESERVED_HANDLE_SEND_TOOL = "__handle_send__" as const;
/** `handle(node).control.cancel()`: idempotent for its epoch; a successor run is never touched. */
export const RESERVED_HANDLE_CANCEL_TOOL = "__handle_cancel__" as const;
/** Canonical oh-my-pi eval-timeout pause operation. */
export const TIMEOUT_PAUSE_OP = "timeout-pause" as const;
/** Canonical oh-my-pi eval-timeout resume operation. */
export const TIMEOUT_RESUME_OP = "timeout-resume" as const;
/** Status op the JS worker emits the moment it receives `interrupt`; proves its event loop is not blocked. */
export const INTERRUPT_ACK_OP = "interrupt-ack" as const;
/** Status op the JS worker emits when a cell child is tracked or exits, so the host can retire it if the worker is lost. */
export const CHILD_LIFECYCLE_OP = "child" as const;
/** Status op the JS worker emits after an idle full collection between cells, carrying the live heap it measured. */
export const MEMORY_COLLECTED_OP = "memory-collected" as const;
