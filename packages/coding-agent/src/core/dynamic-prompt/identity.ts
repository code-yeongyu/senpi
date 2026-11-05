import { APP_NAME } from "../../config.ts";
import type { SharedSections } from "./types.ts";

export function buildIdentitySection(appName = APP_NAME, sharedSections: SharedSections = "diet"): string {
	return sharedSections === "full"
		? `You are ${appName}, a coding agent. Your work should be indistinguishable from a careful senior engineer's.`
		: `You are ${appName}, a coding agent. Work indistinguishable from a careful senior engineer's.`;
}
