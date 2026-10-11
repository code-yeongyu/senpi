import { APP_NAME } from "../../config.ts";

export function buildIdentitySection(appName = APP_NAME): string {
	return `You are ${appName}, a coding agent. Your work should be indistinguishable from a careful senior engineer's.`;
}
