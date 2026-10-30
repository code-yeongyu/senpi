import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { conformanceArchiveFiles } from "./conformance-archive-files.ts";
import { buildManifest } from "../src/conformance/mapping.ts";
import type * as Conformance from "../src/conformance/index.ts";

// Bun is required for archive creation; the compiled package still contains portable JavaScript.
const repo = resolve(import.meta.dirname, "../../..");
const [revision = "HEAD", destination] = process.argv.slice(2);
if (destination === undefined)
	throw new Error("usage: bun packages/agent/scripts/pack-conformance-archive.ts <commit> <archive.tar.gz>");

async function command(cwd: string, argv: string[], capture = false): Promise<string> {
	const child = Bun.spawn(argv, {
		cwd,
		env: process.env,
		stdin: "ignore",
		stdout: capture ? "pipe" : "inherit",
		stderr: "inherit",
	});
	const output = capture ? await new Response(child.stdout).text() : "";
	const code = await child.exited;
	if (code !== 0) throw new Error(`${argv.join(" ")} exited ${code}`);
	return output;
}

const sha = (await command(repo, ["git", "rev-parse", "--verify", `${revision}^{commit}`], true)).trim();
const stage = await mkdtemp(resolve(tmpdir(), "senpi-conformance-"));
try {
	const source = resolve(stage, "source");
	await mkdir(source);
	// git archive, rather than a copy of the checkout, excludes dirty files and stale build output.
	const snapshot = resolve(stage, "source.tar");
	await command(repo, ["git", "archive", "--format=tar", `--output=${snapshot}`, sha]);
	await new Bun.Archive(await readFile(snapshot)).extract(source);
	await command(source, ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
	// Agent's build graph, stopping before CLI/server: every declaration and executable is from this snapshot.
	for (const pkg of ["chord", "telemetry", "ai", "agent"])
		await command(resolve(source, "packages", pkg), ["bun", "run", "build"]);
	const agent = resolve(source, "packages/agent");
	const packDir = resolve(stage, "packed");
	await mkdir(packDir);
	const packed: { filename: string }[] = JSON.parse(await command(agent, [
		"npm", "pack", "--ignore-scripts", "--json", "--pack-destination", packDir,
	], true));
	const filename = packed[0]?.filename;
	if (packed.length !== 1 || filename === undefined) throw new Error("npm pack did not return one package");
	const packageTarball = await readFile(resolve(packDir, filename));
	const packageFiles = await new Bun.Archive(packageTarball).files();
	const pkgFile = packageFiles.get("package/package.json");
	if (pkgFile === undefined) throw new Error("packed package has no manifest");
	const pkg: { exports: { "./conformance": { import: string } } } = JSON.parse(await pkgFile.text());
	const entry = pkg.exports["./conformance"].import;
	if (!entry.startsWith("./dist/")) throw new Error("packed conformance export is not compiled");
	const unpacked = resolve(stage, "unpacked");
	for (const [path, file] of packageFiles) {
		const target = resolve(unpacked, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, await file.bytes());
	}
	// Documented artifact-loading boundary: execute the export from the tarball, not the source checkout.
	const exported: typeof Conformance = await import(pathToFileURL(resolve(unpacked, "package", entry)).href);
	const sourceEntry = resolve(source, "packages/agent/src/conformance/index.ts");
	const original: typeof Conformance = await import(pathToFileURL(sourceEntry).href);
	const readImpl = (path: string): Promise<Uint8Array> => readFile(resolve(source, path));
	const files = await conformanceArchiveFiles(sha, packageTarball, exported.CONFORMANCE_REGISTRY, readImpl);
	const archived = await exported.buildManifest(exported.CONFORMANCE_REGISTRY, async (path) => {
		const bytes = files[path];
		if (bytes === undefined) throw new Error(`archive omitted ${path}`);
		return bytes;
	});
	const baseline = await original.buildManifest(original.CONFORMANCE_REGISTRY, readImpl);
	// Also check the stable contract this producer was compiled against.
	const recomputed = await buildManifest(exported.CONFORMANCE_REGISTRY, readImpl);
	if (archived.suite_hash !== baseline.suite_hash || recomputed.suite_hash !== baseline.suite_hash ||
		JSON.stringify(archived.cases) !== JSON.stringify(baseline.cases))
		throw new Error("packed conformance export differs from same-commit CONF.bun manifest");
	const archive = await new Bun.Archive(files, { compress: "gzip" }).bytes();
	await Bun.write(resolve(destination), archive);
	console.log(JSON.stringify({
		senpiSha: sha,
		suite_hash: archived.suite_hash,
		cases: archived.cases.length,
		archive: resolve(destination),
		sha256: await exported.sha256Hex(archive),
	}));
} finally {
	await rm(stage, { recursive: true, force: true });
}
