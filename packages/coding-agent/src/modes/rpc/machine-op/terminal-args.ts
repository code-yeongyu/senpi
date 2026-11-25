/**
 * The terminal ops' args, decoded as the relay host decodes them (its `terminal-args.ts`, ported): handle_id, last_seq,
 * yield_ms (250..10,000), expectActivityMs, lifecycleVersion 1. `until` is a list of lifecycle states or the
 * machine-wait:v1 map {output?, idle?}; `keys` are named keys (`ctrl+c`, `enter`); `paste` brackets `data`.
 */
import { MACHINE_LIFECYCLES, type MachineLifecycle } from "./live-handle.ts";
import { bad } from "./op-args.ts";
import { encodeKey } from "./terminal-input.ts";
import type { WaitUntil } from "./terminal-wait.ts";
import type { Args } from "./wire.ts";

const YIELD_MIN_MS = 250;
const YIELD_MAX_MS = 10_000;
const EXEC_YIELD_MS = 1_000;
const WRITE_YIELD_MS = 250;
const WAIT_YIELD_MS = 1_000;

const only = (a: Args, allowed: readonly string[], required: readonly string[] = []): void => {
	for (const k of required) if (a[k] === undefined) bad(`${k} is required`);
	for (const k of Object.keys(a)) if (!allowed.includes(k)) bad(`unknown argument ${k}`);
};
const text = (a: Args, k: string): string | undefined => {
	const v = a[k];
	if (v === undefined) return undefined;
	return typeof v === "string" && v.length > 0 ? v : bad(`${k} must be a non-empty string`);
};
const int = (a: Args, k: string, min: number, max: number): number | undefined => {
	const v = a[k];
	if (v === undefined) return undefined;
	return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
		? v
		: bad(`${k} must be an integer in ${min}..${max}`);
};
const isLifecycle = (s: unknown): s is MachineLifecycle => (MACHINE_LIFECYCLES as readonly unknown[]).includes(s);
const untilOf = (v: unknown): WaitUntil | undefined => {
	if (v === undefined) return undefined;
	if (Array.isArray(v)) {
		const states = v.filter(isLifecycle);
		return states.length === v.length ? { states } : bad("until lists an unknown state");
	}
	if (typeof v !== "object" || v === null) return bad("until must be a list of states or a map");
	const m = v as Args;
	only(m, ["output", "idle"]);
	if (m.idle !== undefined && m.idle !== true) bad("until.idle must be true");
	const output = text(m, "output");
	return { ...(output === undefined ? {} : { output }), ...(m.idle === true ? { idle: true } : {}) };
};
const keysOf = (v: unknown): readonly Uint8Array[] | undefined => {
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || v.length === 0) return bad("keys must be a non-empty list");
	return v.map((k) =>
		typeof k === "string" ? (encodeKey(k) ?? bad(`unknown key ${k}`)) : bad("a key must be a string"),
	);
};

export type ExecArgs = Readonly<{ command: string; cwd?: string; yieldMs: number; cols?: number; rows?: number }>;
export type WriteStdinArgs = Readonly<{
	handle: string;
	data?: string;
	keys?: readonly Uint8Array[];
	paste: boolean;
	yieldMs: number;
	lastSeq?: number;
	expectMs?: number;
}>;
export type WaitArgs = Readonly<{ handle: string; yieldMs: number; lastSeq?: number; until?: WaitUntil }>;
export type KillArgs = Readonly<{ handle: string }>;

// Checked first for every terminal op, whatever its own keys: lifecycleVersion and a well-formed last_seq.
const common = (a: Args): number | undefined => {
	if (a.lifecycleVersion !== undefined && a.lifecycleVersion !== 1) bad("lifecycleVersion must be 1");
	return int(a, "last_seq", 0, Number.MAX_SAFE_INTEGER);
};

export const execCommandArgs = (a: Args): ExecArgs => {
	common(a);
	only(a, ["cmd", "command", "workdir", "cwd", "yield_ms", "lifecycleVersion", "cols", "rows"]);
	if ("cmd" in a && "command" in a) bad("cmd and command are mutually exclusive");
	if ("workdir" in a && "cwd" in a) bad("workdir and cwd are mutually exclusive");
	const command = text(a, "cmd") ?? text(a, "command") ?? bad("cmd or command is required");
	const cwd = text(a, "workdir") ?? text(a, "cwd");
	const cols = int(a, "cols", 2, 1_000);
	const rows = int(a, "rows", 2, 1_000);
	return {
		command,
		yieldMs: int(a, "yield_ms", YIELD_MIN_MS, YIELD_MAX_MS) ?? EXEC_YIELD_MS,
		...(cwd === undefined ? {} : { cwd }),
		...(cols === undefined ? {} : { cols }),
		...(rows === undefined ? {} : { rows }),
	};
};
export const writeStdinArgs = (a: Args): WriteStdinArgs => {
	const seq = common(a);
	only(
		a,
		["handle_id", "data", "keys", "paste", "yield_ms", "last_seq", "expectActivityMs", "lifecycleVersion"],
		["handle_id"],
	);
	const data = a.data;
	if (data !== undefined && typeof data !== "string") bad("data must be a string");
	if (a.paste !== undefined && typeof a.paste !== "boolean") bad("paste must be a boolean");
	const keys = keysOf(a.keys);
	const expectMs = int(a, "expectActivityMs", YIELD_MIN_MS, YIELD_MAX_MS);
	return {
		handle: text(a, "handle_id") ?? bad("handle_id is required"),
		paste: a.paste === true,
		yieldMs: int(a, "yield_ms", YIELD_MIN_MS, YIELD_MAX_MS) ?? WRITE_YIELD_MS,
		...(typeof data === "string" ? { data } : {}),
		...(keys === undefined ? {} : { keys }),
		...(seq === undefined ? {} : { lastSeq: seq }),
		...(expectMs === undefined ? {} : { expectMs }),
	};
};
export const waitForCommandArgs = (a: Args): WaitArgs => {
	const seq = common(a);
	only(a, ["handle_id", "last_seq", "yield_ms", "until", "lifecycleVersion"], ["handle_id"]);
	const until = untilOf(a.until);
	return {
		handle: text(a, "handle_id") ?? bad("handle_id is required"),
		yieldMs: int(a, "yield_ms", YIELD_MIN_MS, YIELD_MAX_MS) ?? WAIT_YIELD_MS,
		...(seq === undefined ? {} : { lastSeq: seq }),
		...(until === undefined ? {} : { until }),
	};
};
export const killTerminalArgs = (a: Args): KillArgs => {
	common(a);
	only(a, ["handle_id", "lifecycleVersion"], ["handle_id"]);
	return { handle: text(a, "handle_id") ?? bad("handle_id is required") };
};
