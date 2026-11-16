/**
 * The relay host's own decoders of each op's args (its `op-args.ts`, ported unchanged so every refusal reads the same):
 * any missing, mistyped or unknown key is malformed, refused before any effect. Bytes are base64 text in JSON.
 */
import type {
	EditRequest,
	ExecRequest,
	GlobRequest,
	GrepRequest,
	ListRequest,
	ReadRequest,
	StatRequest,
	WriteRequest,
} from "@code-yeongyu/senpi-machine-ops";
import type { Args } from "./wire.ts";

const READ_RANGE_MAX_BYTES = 1024 * 1024;

export class ArgsError extends Error {}
export const bad = (detail: string): never => {
	throw new ArgsError(detail);
};

const keys = (a: Args, required: readonly string[], optional: readonly string[] = []): void => {
	for (const k of required) if (a[k] === undefined) bad(`${k} is required`);
	const allowed = new Set([...required, ...optional]);
	for (const k of Object.keys(a)) if (!allowed.has(k)) bad(`unknown argument ${k}`);
};
const text = (v: unknown, name: string): string => (typeof v === "string" ? v : bad(`${name} must be a string`));
const nonEmpty = (v: unknown, name: string): string =>
	text(v, name).length > 0 ? text(v, name) : bad(`${name} must not be empty`);
const uint = (v: unknown, name: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(`${name} must be a non-negative integer`);
const opt = <T>(v: unknown, f: (x: unknown, name: string) => T, name: string): T | undefined =>
	v === undefined ? undefined : f(v, name);
const flag = (v: unknown, name: string): boolean => (typeof v === "boolean" ? v : bad(`${name} must be a boolean`));
const bytes = (v: unknown, name: string): Uint8Array => {
	if (v instanceof Uint8Array) return v;
	if (typeof v === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(v) && v.length % 4 === 0)
		return new Uint8Array(Buffer.from(v, "base64"));
	return bad(`${name} must be bytes or base64`);
};
const map = (v: unknown, name: string): Args =>
	typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array)
		? (v as Args)
		: bad(`${name} must be a map`);
const env = (v: unknown, name: string): Record<string, string> => {
	const m = map(v, name);
	return Object.fromEntries(Object.entries(m).map(([k, x]) => [k, text(x, `${name}.${k}`)]));
};
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};
const some = <T extends object>(o: T): Defined<T> =>
	Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Defined<T>;

export const readArgs = (a: Args): ReadRequest => {
	keys(a, ["path"], ["offset", "limit_bytes"]);
	return some({
		path: nonEmpty(a.path, "path"),
		offset: opt(a.offset, uint, "offset"),
		limitBytes: opt(a.limit_bytes, uint, "limit_bytes"),
	});
};
export const readRangeArgs = (a: Args): ReadRequest => {
	keys(a, ["path", "offset", "length"]);
	const length = uint(a.length, "length");
	if (length > READ_RANGE_MAX_BYTES) bad(`length is above ${READ_RANGE_MAX_BYTES}`);
	return { path: nonEmpty(a.path, "path"), offset: uint(a.offset, "offset"), limitBytes: length };
};
export const writeArgs = (a: Args): WriteRequest => {
	keys(a, ["path", "bytes"], ["create_parent_dirs"]);
	return some({
		path: nonEmpty(a.path, "path"),
		bytes: bytes(a.bytes, "bytes"),
		createParentDirs: opt(a.create_parent_dirs, flag, "create_parent_dirs"),
	});
};
export const writeRangeArgs = (a: Args): WriteRequest => {
	keys(a, ["path", "offset", "bytes", "total"]);
	return {
		path: nonEmpty(a.path, "path"),
		offset: uint(a.offset, "offset"),
		bytes: bytes(a.bytes, "bytes"),
		total: uint(a.total, "total"),
	};
};
export const editArgs = (a: Args): EditRequest => {
	keys(a, ["path", "exact", "replacement"]);
	return {
		path: nonEmpty(a.path, "path"),
		exact: text(a.exact, "exact"),
		replacement: text(a.replacement, "replacement"),
	};
};
export const globArgs = (a: Args): GlobRequest => {
	keys(a, ["pattern"], ["cwd", "limit"]);
	return some({
		pattern: nonEmpty(a.pattern, "pattern"),
		cwd: opt(a.cwd, nonEmpty, "cwd"),
		limit: opt(a.limit, uint, "limit"),
	});
};
export const grepArgs = (a: Args): GrepRequest => {
	keys(a, ["path", "pattern"], ["limit"]);
	return some({
		path: nonEmpty(a.path, "path"),
		pattern: nonEmpty(a.pattern, "pattern"),
		limit: opt(a.limit, uint, "limit"),
	});
};
export const statArgs = (a: Args): StatRequest => {
	keys(a, ["path"]);
	return { path: nonEmpty(a.path, "path") };
};
export const listArgs = (a: Args): ListRequest => {
	keys(a, ["path"]);
	return { path: nonEmpty(a.path, "path") };
};
export const shellArgs = (a: Args): ExecRequest => {
	keys(a, ["command"], ["kind", "cwd", "env", "timeoutMs"]);
	if (a.kind !== undefined && a.kind !== "shell") bad("kind must be shell");
	const timeoutMs = opt(a.timeoutMs, uint, "timeoutMs");
	if (timeoutMs === 0) bad("timeoutMs must be positive");
	return some({
		command: nonEmpty(a.command, "command"),
		cwd: opt(a.cwd, nonEmpty, "cwd"),
		env: opt(a.env, env, "env"),
		timeoutMs,
	});
};
export const processInfoArgs = (a: Args): { pid?: number; handleId?: string } => {
	keys(a, [], ["pid", "handleId"]);
	if (a.pid !== undefined && a.handleId !== undefined) bad("pid and handleId are exclusive");
	return some({ pid: opt(a.pid, uint, "pid"), handleId: opt(a.handleId, nonEmpty, "handleId") });
};
export const meshMessageArgs = (a: Args): { topic: string; body: unknown } => {
	keys(a, ["topic", "body"]);
	return { topic: nonEmpty(a.topic, "topic"), body: a.body };
};
