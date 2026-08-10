import { APP_NAME } from "../../config.ts";

export function buildIdentitySection(): string {
	return `You are ${APP_NAME}, a coding agent. Your work should be indistinguishable from a careful senior engineer's.`;
}
