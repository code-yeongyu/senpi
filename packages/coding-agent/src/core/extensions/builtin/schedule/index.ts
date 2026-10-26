/**
 * Durable scheduled prompts: the `schedule_prompt` tool writes job files; the open session delivers its
 * own due jobs (`live-delivery.ts`), and a separate `senpi schedule run` process fires the rest. See
 * `AGENTS.md` in this directory.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../types.ts";
import { createNodeLiveTimer, type LiveTimerPort, registerLiveDelivery } from "./live-delivery.ts";
import { registerScheduleTool } from "./tool.ts";

export interface ScheduleExtensionDeps {
	readonly now?: () => number;
	readonly timer?: () => LiveTimerPort;
}

export function createScheduleExtension(deps: ScheduleExtensionDeps = {}): ExtensionFactory {
	const now = deps.now ?? (() => Date.now());
	return (pi: ExtensionAPI): void => {
		const liveDelivery = registerLiveDelivery(pi, { now, timer: deps.timer ?? createNodeLiveTimer });
		registerScheduleTool(pi, { now, liveDelivery });
	};
}

export default createScheduleExtension();
