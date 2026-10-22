import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { absoluteHostArgs, withAbsoluteHostArgs } from "../src/modes/rpc/protocol-identity.ts";
import { absoluteExecArgv, resolveCliPaths } from "../src/utils/paths.ts";

/**
 * Makes each path-valued host arg absolute against the CALLER's cwd (senpi#3783), with `resolveCliPaths`, the CLI's own
 * rule: every local value resolves whether or not it exists yet, a bare name included (`--session-dir sessions` is
 * `<caller>/sessions`, `--theme dark` is `<caller>/dark`, exactly as the CLI reads them); package specs stay verbatim.
 * The supervisor and its host child run in the agent dir, so a relative value must never reach them unresolved.
 */
describe("host arg paths (senpi#3783)", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const tempCwd = () => {
		const dir = mkdtempSync(join(tmpdir(), "rpc3783-args-"));
		created.push(dir);
		return dir;
	};

	it("resolves every local value against the caller, existing or not, and leaves specs and other flags alone", () => {
		const cwd = tempCwd();
		mkdirSync(join(cwd, "local-ext"));
		expect(
			absoluteHostArgs(
				[
					"--extension",
					"./missing/a.js",
					"-e",
					"npm:foo@1",
					"--theme",
					"dark",
					"--skill",
					"local-ext",
					"--session-dir",
					"sessions",
					"--prompt-template",
					"later.md",
					"--session-runtime",
					"./not-a-path-flag",
				],
				cwd,
			),
		).toEqual([
			"--extension",
			resolve(cwd, "missing/a.js"),
			"-e",
			"npm:foo@1",
			"--theme",
			resolve(cwd, "dark"),
			"--skill",
			resolve(cwd, "local-ext"),
			"--session-dir",
			resolve(cwd, "sessions"),
			"--prompt-template",
			resolve(cwd, "later.md"),
			"--session-runtime",
			"./not-a-path-flag",
		]);
	});

	it("is resolveCliPaths for every path-valued flag value", () => {
		const cwd = tempCwd();
		const values = ["sessions", "./x.js", "~/y", "file:///abs/z.js", "npm:a", "git:h/p", "builtin:b", "/abs/w"];
		for (const flag of ["--extension", "-e", "--skill", "--prompt-template", "--theme", "--session-dir"]) {
			const args = values.flatMap((value) => [flag, value]);
			const resolved = absoluteHostArgs(args, cwd).filter((_, index) => index % 2 === 1);
			expect(resolved).toEqual(resolveCliPaths(cwd, values));
		}
	});

	it("resolves against this process's cwd at the ensure/handoff entry", () => {
		const options = withAbsoluteHostArgs({ socket: "/s", hostArgs: ["--extension", "./x.js"] });
		expect(options.hostArgs).toEqual(["--extension", resolve(process.cwd(), "x.js")]);
		const bare: { readonly socket: string; readonly hostArgs?: readonly string[] } = { socket: "/s" };
		expect(withAbsoluteHostArgs(bare)).toBe(bare);
	});
});

// The exec argv a supervisor's host child re-enters with, read against the directory the supervisor was started from.
describe("exec argv module specifiers (senpi#3783)", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function cwdWithPackage(): { cwd: string; entry: string } {
		const cwd = mkdtempSync(join(tmpdir(), "rpc3783-exec-"));
		created.push(cwd);
		const pkg = join(cwd, "node_modules", "fake-loader");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fake-loader", exports: "./loader.mjs" }));
		writeFileSync(join(pkg, "loader.mjs"), "");
		return { cwd, entry: realpathSync(join(pkg, "loader.mjs")) };
	}

	it("makes relative paths absolute: a file URL for ESM flags, a path for --require", () => {
		const { cwd } = cwdWithPackage();
		expect(absoluteExecArgv(["--import", "./a.mjs", "-r", "../b.cjs", "--loader", "./l.mjs"], cwd)).toEqual([
			"--import",
			pathToFileURL(resolve(cwd, "a.mjs")).href,
			"-r",
			resolve(cwd, "../b.cjs"),
			"--loader",
			pathToFileURL(resolve(cwd, "l.mjs")).href,
		]);
	});

	it("resolves a bare package from cwd and keeps an unresolvable one verbatim", () => {
		const { cwd, entry } = cwdWithPackage();
		expect(
			absoluteExecArgv(["--import", "fake-loader", "--require", "fake-loader", "--import", "nope-pkg"], cwd),
		).toEqual(["--import", pathToFileURL(entry).href, "--require", entry, "--import", "nope-pkg"]);
	});

	it("rewrites the = forms of every module flag", () => {
		const { cwd, entry } = cwdWithPackage();
		expect(
			absoluteExecArgv(
				["--import=fake-loader", "--require=./r.cjs", "--experimental-loader=./x.mjs", "--loader=fake-loader"],
				cwd,
			),
		).toEqual([
			`--import=${pathToFileURL(entry).href}`,
			`--require=${resolve(cwd, "r.cjs")}`,
			`--experimental-loader=${pathToFileURL(resolve(cwd, "x.mjs")).href}`,
			`--loader=${pathToFileURL(entry).href}`,
		]);
	});

	it("keeps absolute paths, file:/data:/node: URLs and other flags verbatim", () => {
		const { cwd } = cwdWithPackage();
		const argv = [
			"--import",
			"/abs/a.mjs",
			"-r",
			"/abs/b.cjs",
			"--import",
			"file:///abs/c.mjs",
			"--import=data:text/javascript,1",
			"--require",
			"node:fs",
			"--enable-source-maps",
			"--conditions=./not-a-module",
		];
		expect(absoluteExecArgv(argv, cwd)).toEqual(argv);
	});

	it("makes relative --import and --require absolute in both the separate and = forms", () => {
		const { cwd } = cwdWithPackage();
		expect(
			absoluteExecArgv(
				["--import", "./x.mjs", "--import=./z.mjs", "--require", "../y.cjs", "--require=./w.cjs"],
				cwd,
			),
		).toEqual([
			"--import",
			pathToFileURL(resolve(cwd, "x.mjs")).href,
			`--import=${pathToFileURL(resolve(cwd, "z.mjs")).href}`,
			"--require",
			resolve(cwd, "../y.cjs"),
			`--require=${resolve(cwd, "w.cjs")}`,
		]);
	});

	it("makes Bun's relative --preload absolute in both forms", () => {
		const { cwd } = cwdWithPackage();
		expect(absoluteExecArgv(["--preload", "./p.ts", "--preload=../q.ts"], cwd)).toEqual([
			"--preload",
			resolve(cwd, "p.ts"),
			`--preload=${resolve(cwd, "../q.ts")}`,
		]);
	});

	it("rejects a bare specifier that names a file in cwd instead of passing it through", () => {
		const { cwd } = cwdWithPackage();
		writeFileSync(join(cwd, "setup.mjs"), "");
		expect(() => absoluteExecArgv(["--import", "setup.mjs"], cwd)).toThrow(
			/ambiguous.*--import.*setup\.mjs.*\.\/setup\.mjs/,
		);
		expect(() => absoluteExecArgv(["--require=setup.mjs"], cwd)).toThrow(/ambiguous.*--require/);
	});

	it("rejects a package-internal #import that cwd cannot resolve instead of passing it through", () => {
		const { cwd } = cwdWithPackage();
		expect(() => absoluteExecArgv(["--import", "#internal"], cwd)).toThrow(/ambiguous.*--import.*#internal/);
	});

	it("records a relative path and a package by one rule: the real path of an existing file", () => {
		const { cwd } = cwdWithPackage();
		const real = realpathSync(cwd);
		const link = `${cwd}-link`;
		created.push(link);
		symlinkSync(real, link);
		writeFileSync(join(real, "r.cjs"), "");
		expect(absoluteExecArgv(["-r", "./r.cjs", "-r", "fake-loader", "-r", "./missing.cjs"], link)).toEqual([
			"-r",
			join(real, "r.cjs"),
			"-r",
			join(real, "node_modules", "fake-loader", "loader.mjs"),
			"-r",
			resolve(link, "missing.cjs"),
		]);
	});
});
