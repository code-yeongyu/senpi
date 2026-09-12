/** Cross-kernel bridge names shared by preludes and host adapters. */
/** Canonical oh-my-pi agent bridge tool name. */
export const RESERVED_AGENT_TOOL = "__agent__" as const;
/** ADAPTATION: senpi delegates output through a reserved kernel-side tool name. */
export const RESERVED_OUTPUT_TOOL = "__output__" as const;
/** ADAPTATION: senpi resolves tool parameter schemas through a reserved kernel-side tool name. */
export const RESERVED_SCHEMA_TOOL = "__schema__" as const;
/** Canonical oh-my-pi eval-timeout pause operation. */
export const TIMEOUT_PAUSE_OP = "timeout-pause" as const;
/** Canonical oh-my-pi eval-timeout resume operation. */
export const TIMEOUT_RESUME_OP = "timeout-resume" as const;
/** Status op the JS worker emits the moment it receives `interrupt`; proves its event loop is not blocked. */
export const INTERRUPT_ACK_OP = "interrupt-ack" as const;
