import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { conformanceArchiveFiles } from "../../scripts/conformance-archive-files.ts";
import { buildManifest } from "../../src/conformance/mapping.ts";
import { CONFORMANCE_REGISTRY } from "../../src/conformance/registry.ts";
import { sha256Hex } from "../../src/conformance/suite-hash.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const readImpl = (path: string) => readFile(`${root}${path}`);
const execute = promisify(execFile);

async function roundTrip(files: Record<string, Uint8Array>): Promise<Record<string, Uint8Array>> {
	const encoded = Object.fromEntries(
		Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]),
	);
	const recovered = await new Promise<string>((done, fail) => {
		const child = execFile(
			"bun",
			[fileURLToPath(new URL("./fixtures/archive-roundtrip.mjs", import.meta.url))],
			{ encoding: "utf8", timeout: 30_000 },
			(error, stdout) => {
				if (error) fail(error);
				else done(stdout);
			},
		);
		child.stdin?.end(JSON.stringify(encoded));
	});
	const decoded: Record<string, string> = JSON.parse(recovered);
	return Object.fromEntries(Object.entries(decoded).map(([path, bytes]) => [path, Buffer.from(bytes, "base64")]));
}

it("ships the exact registry sources that reproduce CONF.bun's suite hash", async () => {
	const packageTarball = new TextEncoder().encode("a packed package supplied by the producer");
	const sha = (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
	const entries = await conformanceArchiveFiles(sha, packageTarball, CONFORMANCE_REGISTRY, readImpl);
	const files = await roundTrip(entries);
	const archiveManifest: {
		senpiSha: string;
		files: { path: string; sha256: string }[];
		packageTarballSha256: string;
	} = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
	expect(archiveManifest.senpiSha).toBe(sha);
	expect(archiveManifest.packageTarballSha256).toBe(await sha256Hex(packageTarball));
	expect(files["package.tgz"]).toEqual(Buffer.from(packageTarball));
	expect(archiveManifest.files.map((entry) => entry.path)).toEqual(
		[...new Set(CONFORMANCE_REGISTRY.map((entry) => entry.impl))].sort(),
	);
	for (const entry of archiveManifest.files) {
		const bytes = files[entry.path];
		if (bytes === undefined) throw new Error(`missing ${entry.path}`);
		expect(Buffer.from(bytes).equals(await readImpl(entry.path))).toBe(true);
		expect(entry.sha256).toBe(await sha256Hex(bytes));
	}
	const archived = await buildManifest(CONFORMANCE_REGISTRY, async (path) => {
		const bytes = files[path];
		if (bytes === undefined) throw new Error(`missing ${path}`);
		return bytes;
	});
	// This is CONF.bun's independent repository-byte reader, not an expected hash made by the packer.
	const bun = await buildManifest(CONFORMANCE_REGISTRY, readImpl);
	expect(archived.suite_hash).toBe(bun.suite_hash);
	expect(archived.cases).toEqual(bun.cases);
	expect(await conformanceArchiveFiles(sha, packageTarball, CONFORMANCE_REGISTRY, readImpl)).toEqual(entries);
});

it("refuses unsafe registry paths and propagates missing implementation bytes", async () => {
	const first = CONFORMANCE_REGISTRY[0];
	if (first === undefined) throw new Error("registry is empty");
	for (const impl of ["../outside.ts", "/absolute.ts", "a\\b.ts"]) {
		await expect(
			conformanceArchiveFiles("a".repeat(40), new Uint8Array(), [{ ...first, impl }], readImpl),
		).rejects.toThrow("implementation path");
	}
	await expect(
		conformanceArchiveFiles("a".repeat(40), new Uint8Array(), [{ ...first, impl: "missing.ts" }], readImpl),
	).rejects.toThrow();
});
