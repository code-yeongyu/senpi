import { isAbsolute } from "node:path";

/** Every SDK query and lane-settings lookup must belong to an explicit session. */
export function requireAnthropicSubscriptionCwd(cwd: string | undefined): string {
	if (!cwd || !isAbsolute(cwd)) {
		throw new Error(
			"Anthropic Subscription requires an absolute session cwd; the host working directory is never used.",
		);
	}
	return cwd;
}
