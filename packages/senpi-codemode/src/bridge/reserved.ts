/** Cross-kernel bridge names shared by preludes and host adapters. */
/** Canonical oh-my-pi agent bridge tool name. */
export const RESERVED_AGENT_TOOL = "__agent__" as const;
/** ADAPTATION: senpi delegates output through a reserved kernel-side tool name. */
export const RESERVED_OUTPUT_TOOL = "__output__" as const;
/** Canonical oh-my-pi eval-timeout pause operation. */
export const TIMEOUT_PAUSE_OP = "timeout-pause" as const;
/** Canonical oh-my-pi eval-timeout resume operation. */
export const TIMEOUT_RESUME_OP = "timeout-resume" as const;
