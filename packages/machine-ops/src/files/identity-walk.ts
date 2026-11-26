import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { MachineOpError } from "../errors.ts";
import { canonicalizeFilesystemPath } from "../policy/filesystem.ts";
import { identityDirectories } from "./identity-access.ts";

const inside = (parent: string, path: string): boolean => {
	const rest = relative(parent, path);
	return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
};

/** A bind mount has a different realpath but the same backing filesystem and
 * subtree. Translate the protected roots into visible mount coordinates before
 * launching helpers which only accept path globs. */
export function mountedIdentityAliases(roots: readonly string[], mountinfo: string): string[] {
	const decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
	const mounts = mountinfo
		.split("\n")
		.flatMap((line) => {
			const [, , device, subtree, mount] = line.split(" ", 5);
			return device && subtree && mount ? [{ device, subtree: decode(subtree), mount: decode(mount) }] : [];
		})
		.sort((a, b) => b.mount.length - a.mount.length);
	const aliases = new Set<string>();
	for (const root of roots) {
		const source = mounts.find((m) => inside(m.mount, root));
		if (!source) continue;
		const backing = resolve(source.subtree, relative(source.mount, root));
		for (const m of mounts) {
			if (m.device !== source.device || m === source) continue;
			if (inside(m.subtree, backing)) aliases.add(resolve(m.mount, relative(m.subtree, backing)));
			else if (inside(backing, m.subtree)) aliases.add(m.mount);
		}
	}
	return [...aliases];
}

export async function identityWalk(root: string) {
	const originals = identityDirectories();
	const canonical = await Promise.all(originals.map(canonicalizeFilesystemPath));
	const dirs = [
		...new Set([
			...originals,
			...canonical,
			...(process.platform === "linux"
				? mountedIdentityAliases(canonical, await readFile("/proc/self/mountinfo", "utf8"))
				: []),
		]),
	];
	const start = await canonicalizeFilesystemPath(root);
	const denied = dirs.find((p) => inside(p, start));
	if (denied) throw new MachineOpError("policy_denied", `IDENTITY_FILE_REFUSED ${denied}`);
	const hidden = (path: string) => dirs.some((p) => inside(p, path));
	const globs = dirs
		.filter((p) => inside(start, p))
		.map(
			(p) =>
				"/" +
				relative(start, p)
					.split(sep)
					.join("/")
					.replace(/[\\*?[\]{}!]/g, "\\$&"),
		);
	return { start, dirs, hidden, globs };
}
