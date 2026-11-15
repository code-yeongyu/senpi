/**
 * Where a process starts, judged where the path really leads (the relay host's `real-path.ts`, ported; asynchronous here
 * because the engine's loop must never block on a wedged mount). The path is walked segment by segment: an existing
 * symlink is resolved before the next segment, "." is skipped and ".." goes to the parent of the real directory reached
 * so far; past a missing segment the rest is appended as text. A dangling or looping link, or a call past the
 * resolution deadline, has no real target: undefined.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { MachineOpError, RESOLUTION_TIMED_OUT, withResolutionDeadline } from "@code-yeongyu/senpi-machine-ops";

type Lookup = Readonly<{ kind: "ok"; value: string }> | Readonly<{ kind: "missing" }> | Readonly<{ kind: "timeout" }>;

async function bounded(operation: Promise<string>): Promise<Lookup> {
	try {
		const value = await withResolutionDeadline(operation);
		return value === RESOLUTION_TIMED_OUT ? { kind: "timeout" } : { kind: "ok", value };
	} catch {
		return { kind: "missing" };
	}
}

const linkKind = (path: string): Promise<Lookup> =>
	bounded(lstat(path).then((info) => (info.isSymbolicLink() ? "link" : "plain")));

export async function realPathUnder(base: string, raw: string): Promise<string | undefined> {
	const root = isAbsolute(raw) ? parse(raw).root : base;
	const start = await bounded(realpath(root));
	if (start.kind !== "ok") return undefined;
	let cur = start.value;
	let missing = false;
	for (const seg of raw.slice(isAbsolute(raw) ? root.length : 0).split(sep === "\\" ? /[\\/]/ : "/")) {
		if (seg === "" || seg === ".") continue;
		// A drive-relative segment (C:foo) names another drive's cwd on Windows; it is never a jailed name.
		if (/^[A-Za-z]:/.test(seg)) return undefined;
		if (seg === "..") {
			cur = dirname(cur);
			continue;
		}
		const next = join(cur, seg);
		if (missing) {
			cur = next;
			continue;
		}
		const kind = await linkKind(next);
		if (kind.kind === "timeout") return undefined;
		if (kind.kind === "missing") {
			missing = true;
			cur = next;
			continue;
		}
		if (kind.value !== "link") {
			cur = next;
			continue;
		}
		const target = await bounded(realpath(next));
		if (target.kind !== "ok") return undefined;
		cur = target.value;
	}
	return cur;
}

export const within = (root: string, target: string): boolean => {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The real place a process starts, checked against a confined root (throws policy_denied); an unconfined root only
 * anchors a relative cwd, and the OS decides whether the process may start there.
 */
export async function spawnPathIn(root: string, raw: string, confined: boolean): Promise<string> {
	const real = await realPathUnder(root, raw);
	if (!confined) return real ?? resolve(root, raw);
	const realRoot = await realPathUnder(root, ".");
	if (realRoot === undefined || real === undefined || !within(realRoot, real))
		throw new MachineOpError("policy_denied", `${raw} does not resolve inside ${root}`);
	return real;
}
