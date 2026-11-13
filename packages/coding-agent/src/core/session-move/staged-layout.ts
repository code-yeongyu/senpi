/**
 * Where a move's files are written while it is staged, as names inside the staging folder. The session file is staged
 * under its own file name beside the sidecars, which lose their `files/` prefix, and every payload file goes under
 * one folder of the staging's own. This is not the bundle's layout, so two names can be one here that are apart
 * there (a sidecar named as the session file in another letter case), and the reverse.
 */
import type { BundleFile, MoveManifest } from "./bundle.ts";

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
