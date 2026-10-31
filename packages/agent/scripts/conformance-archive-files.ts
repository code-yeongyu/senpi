import type { RegisteredCase } from "../src/conformance/registry.ts";
import { sha256Hex } from "../src/conformance/suite-hash.ts";

/** Archive bytes are original sources, never the compiled implementation's spelling. */
export async function conformanceArchiveFiles(
	senpiSha: string,
	packageTarball: Uint8Array,
	registry: readonly RegisteredCase[],
	readImpl: (path: string) => Promise<Uint8Array>,
): Promise<Record<string, Uint8Array>> {
	if (!/^[a-f0-9]{40}$/.test(senpiSha)) throw new Error("expected a full senpi commit SHA");
	const output: Record<string, Uint8Array> = { "package.tgz": packageTarball };
	const files: { path: string; sha256: string }[] = [];
	for (const path of [...new Set(registry.map((entry) => entry.impl))].sort()) {
		if (!path.endsWith(".ts") || path.includes("\\") || path.includes(":") ||
			path.split("/").some((part) => part === "" || part === "." || part === ".."))
			throw new Error(`invalid implementation path: ${path}`);
		const bytes = await readImpl(path);
		output[path] = bytes;
		files.push({ path, sha256: await sha256Hex(bytes) });
	}
	output["manifest.json"] = new TextEncoder().encode(`${JSON.stringify({
		senpiSha, files, packageTarballSha256: await sha256Hex(packageTarball),
	}, null, 2)}\n`);
	return output;
}
