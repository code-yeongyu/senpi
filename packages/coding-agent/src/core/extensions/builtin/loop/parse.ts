import type { RequestedInterval, RequestedIntervalUnit } from "./types.ts";

// `types.ts` is the single type home for the whole extension; re-exported so the parser's
// own consumers keep importing the canonical declaration.
export type { RequestedInterval };

export type LoopTarget =
	| { readonly type: "all" }
	| { readonly type: "id"; readonly id: string }
	| { readonly type: "implicit" };

export type ParsedLoopInvocation =
	| { readonly kind: "stop"; readonly target: LoopTarget; readonly originalArgs: string }
	| { readonly kind: "status"; readonly originalArgs: string }
	| { readonly kind: "pause"; readonly target: LoopTarget; readonly originalArgs: string }
	| { readonly kind: "resume"; readonly target: LoopTarget; readonly originalArgs: string }
	| {
			readonly kind: "fixed";
			readonly interval: RequestedInterval;
			readonly prompt: string;
			readonly originalArgs: string;
	  }
	| { readonly kind: "dynamic"; readonly prompt: string; readonly originalArgs: string }
	| { readonly kind: "bare"; readonly interval?: RequestedInterval; readonly originalArgs: string }
	| { readonly kind: "invalid"; readonly reason: string; readonly usage: string };

const LEADING_INTERVAL_RE = /^\d+[smhd]$/;

const TRAILING_EVERY_RE =
	/(?:^|\s)every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i;

const USAGE = `Usage: /loop [interval] <prompt>
Examples:
  /loop 5m check the deploy
  /loop check the deploy every 20m
  /loop check the deploy
  /loop stop [id|all]
  /loop status
  /loop pause [id|all]
  /loop resume [id|all]`;

function normalizeUnit(unit: string): RequestedIntervalUnit {
	const lower = unit.toLowerCase();
	if (lower.startsWith("s")) return "s";
	if (lower.startsWith("m")) return "m";
	if (lower.startsWith("h")) return "h";
	return "d";
}

function parseIntervalToken(token: string): RequestedInterval {
	const value = Number.parseInt(token.slice(0, -1), 10);
	const unit = token.slice(-1) as RequestedIntervalUnit;
	return { value, unit, raw: token };
}

function parseTrailingInterval(raw: string): { interval: RequestedInterval; remaining: string } | null {
	const match = TRAILING_EVERY_RE.exec(raw);
	if (!match) return null;
	const value = Number.parseInt(match[1], 10);
	const unit = normalizeUnit(match[2]);
	const matchedPrefix = match[0];
	const remaining = raw.slice(0, raw.length - matchedPrefix.length).trim();
	return {
		interval: { value, unit, raw: `${value}${unit}` },
		remaining,
	};
}

function parseTarget(rest: string): LoopTarget {
	const trimmed = rest.trim();
	if (trimmed === "" || trimmed.toLowerCase() === "implicit") return { type: "implicit" };
	if (trimmed.toLowerCase() === "all") return { type: "all" };
	return { type: "id", id: trimmed.split(/\s+/)[0] };
}

function makeInvalid(reason: string): ParsedLoopInvocation {
	return { kind: "invalid", reason, usage: USAGE };
}

function classifyInterval(interval: RequestedInterval, remaining: string, originalArgs: string): ParsedLoopInvocation {
	if (interval.value === 0) {
		return makeInvalid("Interval amount must be greater than zero.");
	}
	const prompt = remaining.trim();
	if (prompt === "") {
		return { kind: "bare", interval, originalArgs };
	}
	return { kind: "fixed", interval, prompt, originalArgs };
}

export function parseLoopArgs(raw: string): ParsedLoopInvocation {
	const originalArgs = raw;
	const trimmed = raw.trim();

	if (trimmed !== "") {
		const firstToken = trimmed.split(/\s+/)[0].toLowerCase();
		switch (firstToken) {
			case "stop":
				return { kind: "stop", target: parseTarget(trimmed.slice(firstToken.length)), originalArgs };
			case "status":
				return { kind: "status", originalArgs };
			case "pause":
				return { kind: "pause", target: parseTarget(trimmed.slice(firstToken.length)), originalArgs };
			case "resume":
				return { kind: "resume", target: parseTarget(trimmed.slice(firstToken.length)), originalArgs };
		}
	}

	const leadingMatch = /^\s*(\d+[smhd])\b/.exec(raw);
	if (leadingMatch !== null && LEADING_INTERVAL_RE.test(leadingMatch[1] ?? "")) {
		const interval = parseIntervalToken(leadingMatch[1]);
		const remaining = raw.slice(leadingMatch[0].length).trim();
		return classifyInterval(interval, remaining, originalArgs);
	}

	const trailing = parseTrailingInterval(raw);
	if (trailing) {
		return classifyInterval(trailing.interval, trailing.remaining, originalArgs);
	}

	if (trimmed === "") {
		return { kind: "bare", originalArgs };
	}

	return { kind: "dynamic", prompt: trimmed, originalArgs };
}
