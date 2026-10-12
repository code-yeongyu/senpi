import { createHash } from "node:crypto";
import { appendDebugLogEntry } from "../hidden-stdout-log.ts";
import { redactSensitiveOutput } from "../sensitive-output.ts";
import type { CredentialBlock } from "./classify.ts";

const EXCERPT_CHARS = 300;

export type CredentialBlockLogInput = {
	providerId: string;
	slot: { name: string; lane: string };
	block: CredentialBlock;
	modelId?: string;
	failureCount?: number;
	blockedUntil?: number;
	nowMs: number;
	providerText?: string;
};

/**
 * One debug-log line per credential block (senpi#3216): why the pool took an account out, until
 * when, where the cooldown came from, and what the provider said. A wrongly long block can then be
 * explained from the user's machine. The account is named by a short hash of its slot name, never
 * by its name or material, and the provider excerpt goes through the shared secret redaction.
 */
export function formatCredentialBlockLog(input: CredentialBlockLogInput): string {
	const { block } = input;
	const fields = [
		`provider=${input.providerId}`,
		`account=${slotRef(input.slot.lane, input.slot.name)}`,
		`reason=${block.reason}`,
	];
	if (block.reason === "rate_limit") {
		fields.push(`cooldown=${block.cooldownSource ?? "backoff"}`);
		if (block.modelFamily !== undefined) fields.push(`modelFamily=${block.modelFamily}`);
	}
	if (input.modelId !== undefined) fields.push(`model=${input.modelId}`);
	if (input.failureCount !== undefined) fields.push(`failureCount=${input.failureCount}`);
	if (input.blockedUntil !== undefined) {
		fields.push(`until=${new Date(input.blockedUntil).toISOString()}`);
		fields.push(`for=${formatDuration(input.blockedUntil - input.nowMs)}`);
	}
	const excerpt = input.providerText === undefined ? undefined : providerExcerpt(input.providerText);
	return excerpt === undefined ? fields.join(" ") : `${fields.join(" ")}\nprovider said: ${excerpt}`;
}

export function logCredentialBlock(input: CredentialBlockLogInput): void {
	try {
		appendDebugLogEntry("credential pool blocked an account", formatCredentialBlockLog(input));
	} catch {
		// The debug log is diagnostics only: an unwritable log never fails or slows a request.
	}
}

function slotRef(lane: string, name: string): string {
	return `${lane}:${createHash("sha256").update(`${lane}\0${name}`).digest("hex").slice(0, 8)}`;
}

// Credential shapes a provider error body can echo that the shared redaction may not cover.
const EXTRA_SECRET_PATTERNS: readonly RegExp[] = [
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/("(?:access|refresh|id)_token"\s*:\s*")[^"]*(")/gi,
	/\b((?:set-)?cookie\s*[:=]\s*)[^\n]*/gi,
	/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
];

function redactCredentialShapes(text: string): string {
	let out = text;
	for (const pattern of EXTRA_SECRET_PATTERNS) {
		out = out.replace(pattern, (match: string, ...groups: unknown[]) => {
			const [prefix, suffix] = groups;
			if (typeof prefix !== "string" || !match.startsWith(prefix)) return "<redacted>";
			if (typeof suffix === "string") return `${prefix}<redacted>${suffix}`;
			return /cookie/i.test(prefix) ? `${prefix}<redacted>` : "<redacted>";
		});
	}
	return out;
}

function providerExcerpt(text: string): string {
	const oneLine = redactCredentialShapes(redactSensitiveOutput(text)).replace(/\s+/g, " ").trim();
	return oneLine.length <= EXCERPT_CHARS ? oneLine : `${oneLine.slice(0, EXCERPT_CHARS)}…`;
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.round(ms / 1000)}s`;
	if (minutes < 120) return `${minutes}m`;
	return `${(minutes / 60).toFixed(1)}h`;
}
