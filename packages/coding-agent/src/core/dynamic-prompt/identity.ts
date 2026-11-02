import { APP_NAME } from "../../config.ts";

export function buildIdentitySection(appName = APP_NAME): string {
	return `You are ${appName}, a coding agent. Work indistinguishable from a careful senior engineer's.`;
}
