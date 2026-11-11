import { createHmac } from "node:crypto";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { installSalt } from "./install-salt.ts";

const SALT_FILE = "session-affinity-salt";

function sessionAffinityKey(sessionId: string, agentDir: string): string {
	return createHmac("sha256", installSalt(agentDir, SALT_FILE)).update(`session-affinity\0${sessionId}`).digest("hex");
}

function claudeCodeUserId(key: string): string {
	const session = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
	return `user_${key}_account__session_${session}`;
}

/**
 * Stream options that pin an Anthropic Messages session to one upstream account behind a
 * multi-account gateway (senpi#2553): `metadata.user_id` in the shape Claude Code sends, and the
 * session-affinity header where the model's compat sends one. Both carry an HMAC of the session id
 * under a per-install salt, so the gateway sees a stable key per session and never the session id
 * or any account or user identity. Request metadata sits outside the prompt-cache key, so the cached
 * prefix bytes are unchanged. A caller-supplied `metadata.user_id` wins.
 */
export function sessionAffinityStreamOptions(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	enabled: boolean,
	agentDir: string,
): Pick<SimpleStreamOptions, "metadata" | "sessionAffinityKey"> {
	const sessionId = options?.affinitySessionId ?? options?.sessionId;
	if (!enabled || !sessionId || model.api !== "anthropic-messages") return {};
	const compat = model.compat as { sendSessionAffinityHeaders?: boolean } | undefined;
	if (compat?.sendSessionAffinityHeaders === false) return {};
	const key = sessionAffinityKey(sessionId, agentDir);
	if (typeof options?.metadata?.user_id === "string") return { sessionAffinityKey: key };
	return { sessionAffinityKey: key, metadata: { ...options?.metadata, user_id: claudeCodeUserId(key) } };
}
