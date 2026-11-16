/**
 * Where a move's files are written while it is staged, as names inside the staging folder. The session file is staged
 * under its own file name beside the sidecars, which lose their `files/` prefix, and every payload file goes under
 * one folder of the staging's own. This is not the bundle's layout, so two names can be one here that are apart
 * there (a sidecar named as the session file in another letter case), and the reverse.
 */
import { type BundleFile, type MoveManifest, shown } from "./bundle.ts";

/** The folder inside staging that holds the payload files until they are placed. */
export const STAGED_PAYLOADS = ".payloads";

/** The staged name of the session file or of a sidecar. */
export function stagedName(manifest: MoveManifest, item: BundleFile): string {
	return item === manifest.session ? manifest.sessionFileName : item.path.replace(/^files\//, "");
}

/** Every name a staged move writes inside its staging folder. */
export function stagedNames(manifest: MoveManifest): string[] {
	return [
		...[manifest.session, ...manifest.sidecars].map((item) => stagedName(manifest, item)),
		...manifest.payloads.flatMap((payload) => payload.files).map((file) => `${STAGED_PAYLOADS}/${file.path}`),
	];
}

/**
 * Why two different files of the bundle cannot both be staged, or `undefined` when every staged name is one file's:
 * a sidecar listed under the session file's own name, or one under the payload folder beside a payload of that path.
 * A file listed twice is one file, so it is told apart by the bundle path its staged name came from.
 */
export function stagedTwice(manifest: MoveManifest): string | undefined {
	const staged: (readonly [name: string, path: string])[] = [
		...[manifest.session, ...manifest.sidecars].map((item) => [stagedName(manifest, item), item.path] as const),
		...manifest.payloads
			.flatMap((payload) => payload.files)
			.map((file) => [`${STAGED_PAYLOADS}/${file.path}`, file.path] as const),
	];
	const from = new Map<string, string>();
	for (const [name, path] of staged) {
		const other = from.get(name);
		if (other !== undefined && other !== path)
			return `${shown(path)} and ${shown(other)} would be staged as one file`;
		from.set(name, path);
	}
	return undefined;
}
