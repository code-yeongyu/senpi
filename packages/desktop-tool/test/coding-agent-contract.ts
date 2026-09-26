// Type-level contract, checked by the root `tsc --noEmit`: `src/` may not import coding-agent, so this file pins
// that the structurally typed tool, parser, and host context still fit coding-agent's real declarations.
import type { ToolPermissionParser } from "../../coding-agent/src/core/extensions/builtin/permission-system/parsers.ts";
import type { ExtensionContext, ToolDefinition } from "../../coding-agent/src/core/extensions/types.ts";
import { computerPermissionParser } from "../src/permission.ts";
import type { ComputerHostContext } from "../src/session.ts";
import type { ComputerTool, ComputerToolDetails } from "../src/tool.ts";

declare const tool: ComputerTool;
declare const context: ExtensionContext;

export const registrable: ToolDefinition<ComputerTool["parameters"], ComputerToolDetails> = tool;
export const registrableParser: ToolPermissionParser = computerPermissionParser;
export const hostContext: ComputerHostContext = context;
