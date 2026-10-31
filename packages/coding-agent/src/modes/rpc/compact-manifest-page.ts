import { catalogDigest } from "./compact-catalog-codec.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { RecoveryPage } from "./compact-recovery-bytes.ts";
import type { RecoveryManifest } from "./compact-recovery-manifest.ts";

/** The bounded manifest itself is discoverable under its token on the one S11 page route. */
export async function manifestPage(manifest: Promise<RecoveryManifest>, offset: number): Promise<RecoveryPage> {
	if (offset !== 0) throw new CompactReadError("range");
	const bytes = Buffer.from(JSON.stringify(await manifest), "utf16le");
	if (bytes.length > 65_536) throw new CompactReadError("size_limit");
	return {
		offset: 0,
		length: bytes.length,
		bytes,
		digest: catalogDigest("fragment", bytes),
		next: null,
		complete: true,
	};
}
