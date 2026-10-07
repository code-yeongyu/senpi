/**
 * Durable scheduled prompts: the `schedule_prompt` tool writes job files that a separate
 * `senpi schedule run` process fires later. See `AGENTS.md` in this directory.
 */

import type { ExtensionAPI } from "../../types.ts";
import { registerScheduleTool } from "./tool.ts";

export default function scheduleExtension(pi: ExtensionAPI): void {
	registerScheduleTool(pi, { now: () => Date.now() });
}
