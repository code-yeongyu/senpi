import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";

/** Stable, content-free display names; paths are hashed only when names collide. */
export function promptSizeExtensionNames(
	paths: readonly string[],
	packageNameOf: (path: string) => string | undefined = () => undefined,
): ReadonlyMap<string, string> {
	const names = new Map<string, string>();
	for (const path of paths) {
		const stem = basename(path).replace(/\.[^.]+$/, "");
		const name = path.startsWith("<")
			? path.replace(/^<[^:]+:|>$/g, "")
			: (packageNameOf(path) ?? (stem === "index" || stem === "main" ? basename(dirname(path)) : stem));
		names.set(path, name);
	}
	const counts = new Map<string, number>();
	for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
	for (const [path, name] of names) {
		if ((counts.get(name) ?? 0) > 1) {
			names.set(path, `${name}:${createHash("sha256").update(path).digest("hex").slice(0, 8)}`);
		}
	}
	return names;
}
