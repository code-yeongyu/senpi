/**
 * The node loader choice of the omo#12965 `pi.engine` probe (test/extensions/pi-engine.test.ts): the freshness rule of
 * `selectProbeLoader` and the manifest reads of `resolveEngineBuilds`, neither of which may throw.
 */
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Build,
	NODE_FS,
	type ProbeFs,
	type ProbeLoader,
	type ReadText,
	resolveEngineBuilds,
	selectProbeLoader,
} from "../support/engine-build-freshness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("selectProbeLoader", () => {
	const T = 1_000_000_000;

	function tree(): { root: string; build: Build; paths: string[] } {
		const root = mkdtempSync(join(tmpdir(), "senpi-probe-loader-"));
		roots.push(root);
		const sources = join(root, "src");
		mkdirSync(join(sources, "nested"), { recursive: true });
		writeFileSync(join(sources, "a.ts"), "");
		writeFileSync(join(sources, "nested", "b.ts"), "");
		const paths = [join(sources, "a.ts"), join(sources, "nested", "b.ts"), join(sources, "nested"), sources];
		for (const path of paths) utimesSync(path, T, T);
		const output = join(root, "dist");
		return { root, build: { entry: join(output, "loader.js"), output, sources }, paths };
	}

	function writeOutput(build: Build, seconds: number, file = "loader.js"): void {
		const path = join(build.output, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "");
		utimesSync(path, seconds, seconds);
	}

	/** The entry and the outputs of both sources (`a.ts` and `nested/b.ts`), all at `seconds`. */
	function writeBuild(build: Build, seconds: number): void {
		for (const file of ["loader.js", "a.js", join("nested", "b.js")]) writeOutput(build, seconds, file);
	}

	it("takes the source when the build output is missing", () => {
		expect(selectProbeLoader([tree().build]).loader).toBe("source");
	});

	it("takes the source when the build output directory is empty", () => {
		const { build } = tree();
		mkdirSync(build.output);
		expect(selectProbeLoader([build]).loader).toBe("source");
	});

	it("takes the build when its output is newer than every source", () => {
		const { build } = tree();
		writeBuild(build, T + 10);
		expect(selectProbeLoader([build]).loader).toBe("built");
	});

	it("takes the source when the output is non-empty and fresh but the entry file is missing", () => {
		const { build } = tree();
		for (const file of ["a.js", join("nested", "b.js"), "cli.js"]) writeOutput(build, T + 10, file);
		expect(selectProbeLoader([build])).toEqual({ loader: "source", reason: `missing ${build.entry}` });
	});

	it("takes the build when an old leftover output has no current source", () => {
		const { build } = tree();
		writeBuild(build, T + 10);
		writeOutput(build, T - 100, "deleted-source.js");
		expect(selectProbeLoader([build]).loader).toBe("built");
	});

	it("takes the source when one source file is newer than the build output", () => {
		const { build, paths } = tree();
		writeBuild(build, T + 10);
		utimesSync(paths[1], T + 20, T + 20);
		expect(selectProbeLoader([build]).loader).toBe("source");
	});

	it("takes the source when the entry output is fresh but a sibling output is older than a source", () => {
		const { build, paths } = tree();
		writeBuild(build, T + 10);
		writeOutput(build, T + 5, join("nested", "b.js"));
		utimesSync(paths[0], T + 7, T + 7);
		expect(selectProbeLoader([build])).toEqual({
			loader: "source",
			reason: `${join(build.output, "nested", "b.js")} is not newer than ${paths[0]}`,
		});
	});

	it("takes the source when the build output and the sources have the same mtime", () => {
		const { build } = tree();
		writeBuild(build, T);
		expect(selectProbeLoader([build]).loader).toBe("source");
	});

	it(
		"returns and takes the build when a symbolic link under the sources loops back to them",
		{ timeout: 5_000 },
		() => {
			const { build } = tree();
			writeBuild(build, T + 10);
			const link = join(build.sources, "loop");
			symlinkSync(build.sources, link, "dir");
			utimesSync(build.sources, T, T);
			expect(selectProbeLoader([build])).toEqual({ loader: "built", skippedLinks: [link] });
		},
	);

	it(
		"takes the build when a symbolic link under the sources points outside them at a newer file",
		{ timeout: 5_000 },
		() => {
			const { root, build } = tree();
			writeBuild(build, T + 10);
			const outside = join(root, "outside.ts");
			writeFileSync(outside, "");
			utimesSync(outside, T + 20, T + 20);
			const link = join(build.sources, "linked.ts");
			symlinkSync(outside, link);
			utimesSync(build.sources, T, T);
			expect(selectProbeLoader([build])).toEqual({ loader: "built", skippedLinks: [link] });
		},
	);

	it("takes the source, without throwing, when the sources root is itself a symbolic link", { timeout: 5_000 }, () => {
		const { root, build } = tree();
		writeBuild(build, T + 10);
		const sources = join(root, "linked-src");
		symlinkSync(build.sources, sources, "dir");
		expect(selectProbeLoader([{ ...build, sources }])).toEqual({
			loader: "source",
			reason: `no source files under ${sources}`,
			skippedLinks: [sources],
		});
	});

	function fsError(code: string, path: string): never {
		throw Object.assign(new Error(`${code}: injected failure, '${path}'`), { code });
	}

	/** A fresh build over the tree; `failing` is the path whose code the reason must name. */
	interface FsFailureCase {
		name: string;
		code: string;
		setup(): { build: Build; failing: string; fs?: ProbeFs };
	}

	it.each<FsFailureCase>([
		{
			name: "the sources root is missing",
			code: "ENOENT",
			setup: () => {
				const { root, build } = tree();
				writeBuild(build, T + 10);
				const sources = join(root, "missing-src");
				return { build: { ...build, sources }, failing: sources };
			},
		},
		{
			name: "the sources root is a regular file, so there is no source tree",
			code: "ENOTDIR",
			setup: () => {
				const { root, build } = tree();
				writeBuild(build, T + 10);
				const sources = join(root, "src-file");
				writeFileSync(sources, "");
				utimesSync(sources, T, T);
				return { build: { ...build, sources }, failing: sources };
			},
		},
		{
			name: "reading a directory under the sources fails with EACCES",
			code: "EACCES",
			setup: () => {
				const { build } = tree();
				writeBuild(build, T + 10);
				const failing = join(build.sources, "nested");
				const fs: ProbeFs = {
					...NODE_FS,
					readdirSync: (path) => (path === failing ? fsError("EACCES", path) : readdirSync(path)),
				};
				return { build, failing, fs };
			},
		},
		{
			name: "a listed file vanishes before its lstat",
			code: "ENOENT",
			setup: () => {
				const { build } = tree();
				writeBuild(build, T + 10);
				const failing = join(build.sources, "nested", "b.ts");
				const fs: ProbeFs = {
					...NODE_FS,
					lstatSync: (path) => (path === failing ? fsError("ENOENT", path) : lstatSync(path)),
				};
				return { build, failing, fs };
			},
		},
	])(
		"takes the source, without throwing, when $name",
		({ code, setup }) => {
			const { build, failing, fs } = setup();
			let choice: ProbeLoader | undefined;
			expect(() => {
				choice = selectProbeLoader([build], fs);
			}).not.toThrow();
			expect(choice).toMatchObject({ loader: "source", reason: expect.stringContaining(`${code}: ${failing}`) });
		},
		5_000,
	);
});

describe("resolveEngineBuilds", () => {
	const loaderBuild: Build = { entry: "/engine/dist/loader.js", output: "/engine/dist", sources: "/engine/src" };

	/** A packages directory with one directory per name, holding `package.json` with the given text. */
	function packagesDir(manifests: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "senpi-engine-builds-"));
		roots.push(dir);
		for (const [name, text] of Object.entries(manifests)) {
			mkdirSync(join(dir, name));
			writeFileSync(join(dir, name, "package.json"), text);
		}
		return dir;
	}

	it("gives one build per name, with main as the entry, its directory as the output and src as the sources", () => {
		const dir = packagesDir({
			a: JSON.stringify({ main: "dist/index.js" }),
			b: JSON.stringify({ main: "./lib/main.js" }),
		});
		expect(resolveEngineBuilds(dir, ["a", "b"], loaderBuild)).toEqual([
			loaderBuild,
			{ entry: join(dir, "a", "dist", "index.js"), output: join(dir, "a", "dist"), sources: join(dir, "a", "src") },
			{ entry: join(dir, "b", "lib", "main.js"), output: join(dir, "b", "lib"), sources: join(dir, "b", "src") },
		]);
	});

	/** One dependency `a`; `reason` gets the path of its manifest. */
	interface ManifestFailureCase {
		name: string;
		setup(): { dir: string; readText?: ReadText };
		reason(manifest: string): string;
	}

	it.each<ManifestFailureCase>([
		{
			name: "the package.json is missing",
			setup: () => {
				const dir = packagesDir({});
				mkdirSync(join(dir, "a"));
				return { dir };
			},
			reason: (manifest) => `ENOENT: ${manifest}`,
		},
		{
			name: "the package.json is not valid JSON",
			setup: () => ({ dir: packagesDir({ a: "{ main: " }) }),
			reason: (manifest) => `invalid JSON: ${manifest}`,
		},
		{
			name: "the package.json has no main",
			setup: () => ({ dir: packagesDir({ a: JSON.stringify({ name: "a" }) }) }),
			reason: (manifest) => `no main in ${manifest}`,
		},
		{
			name: "the main is a number, not a string",
			setup: () => ({ dir: packagesDir({ a: JSON.stringify({ main: 42 }) }) }),
			reason: (manifest) => `no main in ${manifest}`,
		},
		{
			name: "reading the package.json fails with EACCES",
			setup: () => ({
				dir: packagesDir({ a: JSON.stringify({ main: "dist/index.js" }) }),
				readText: (path) => {
					throw Object.assign(new Error(`EACCES: injected failure, '${path}'`), { code: "EACCES" });
				},
			}),
			reason: (manifest) => `EACCES: ${manifest}`,
		},
	])(
		"takes the source, without throwing, when $name",
		({ setup, reason }) => {
			const { dir, readText } = setup();
			let answer: ReturnType<typeof resolveEngineBuilds> | undefined;
			expect(() => {
				answer = resolveEngineBuilds(dir, ["a"], loaderBuild, readText);
			}).not.toThrow();
			expect(answer).toEqual({ loader: "source", reason: reason(join(dir, "a", "package.json")) });
		},
		5_000,
	);
});
