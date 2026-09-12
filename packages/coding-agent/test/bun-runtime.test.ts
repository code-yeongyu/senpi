import { describe, expect, it } from "vitest";
import { type BunRuntimeOptions, findBunBinary, isUnderBunGlobalTree, resolveBunReexec } from "../src/bun-runtime.ts";

/**
 * Every case below injects its whole world (env, homedir, platform, filesystem probes).
 * Nothing here may read the host PATH, the host HOME, or the real `~/.bun` install: CI
 * runners ship real interpreters and a real bun, so a single host read is a latent failure.
 */
function options(overrides: Partial<BunRuntimeOptions> & { readonly files?: readonly string[] }): BunRuntimeOptions {
	const files = new Set(overrides.files ?? []);
	return {
		env: overrides.env ?? {},
		homedir: overrides.homedir ?? "/home/tester",
		platform: overrides.platform ?? "linux",
		exists: overrides.exists ?? ((path: string) => files.has(path)),
		realpath: overrides.realpath ?? ((path: string) => path),
	};
}

describe("isUnderBunGlobalTree", () => {
	it("accepts a script inside the default bun global tree", () => {
		const opts = options({ homedir: "/home/tester" });
		const script = "/home/tester/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/cli.js";
		expect(isUnderBunGlobalTree(script, opts)).toBe(true);
	});

	it("prefers BUN_INSTALL over the home directory", () => {
		const opts = options({ env: { BUN_INSTALL: "/opt/bun" }, homedir: "/home/tester" });
		expect(isUnderBunGlobalTree("/opt/bun/install/global/node_modules/pkg/dist/cli.js", opts)).toBe(true);
		expect(isUnderBunGlobalTree("/home/tester/.bun/install/global/node_modules/pkg/dist/cli.js", opts)).toBe(false);
	});

	it("rejects an npm global install", () => {
		const opts = options({ homedir: "/home/tester" });
		expect(isUnderBunGlobalTree("/usr/local/lib/node_modules/@code-yeongyu/senpi/dist/cli.js", opts)).toBe(false);
	});

	it("matches win32 paths written with backslashes", () => {
		const opts = options({ platform: "win32", homedir: "C:\\Users\\tester" });
		const script = "C:\\Users\\tester\\.bun\\install\\global\\node_modules\\@code-yeongyu\\senpi\\dist\\cli.js";
		expect(isUnderBunGlobalTree(script, opts)).toBe(true);
	});

	it("matches a script under a symlinked install root", () => {
		// macOS resolves `/tmp` to `/private/tmp`, so a script realpath never shares a literal
		// prefix with a `BUN_INSTALL=/tmp/...` root until the root is resolved too.
		const opts = options({
			env: { BUN_INSTALL: "/tmp/bunroot" },
			realpath: (path: string) => path.replace(/^\/tmp\//, "/private/tmp/"),
		});
		expect(isUnderBunGlobalTree("/private/tmp/bunroot/install/global/node_modules/pkg/dist/cli.js", opts)).toBe(true);
	});

	it("still matches when the install root cannot be resolved", () => {
		const opts = options({
			env: { BUN_INSTALL: "/opt/bun" },
			realpath: () => {
				throw new Error("ENOENT");
			},
		});
		expect(isUnderBunGlobalTree("/opt/bun/install/global/node_modules/pkg/dist/cli.js", opts)).toBe(true);
	});

	it("does not treat a sibling directory as the global tree", () => {
		const opts = options({ homedir: "/home/tester" });
		expect(isUnderBunGlobalTree("/home/tester/.bun/install/globalish/pkg/cli.js", opts)).toBe(false);
	});
});

describe("findBunBinary", () => {
	it("prefers the BUN_INSTALL bin directory", () => {
		const opts = options({
			env: { BUN_INSTALL: "/opt/bun", PATH: "/usr/bin" },
			files: ["/opt/bun/bin/bun", "/home/tester/.bun/bin/bun", "/usr/bin/bun"],
		});
		expect(findBunBinary(opts)).toBe("/opt/bun/bin/bun");
	});

	it("falls back to the home bun bin directory", () => {
		const opts = options({
			env: { PATH: "/usr/bin" },
			files: ["/home/tester/.bun/bin/bun", "/usr/bin/bun"],
		});
		expect(findBunBinary(opts)).toBe("/home/tester/.bun/bin/bun");
	});

	it("falls back to a PATH scan", () => {
		const opts = options({
			env: { PATH: "/empty:/usr/local/bin" },
			files: ["/usr/local/bin/bun"],
		});
		expect(findBunBinary(opts)).toBe("/usr/local/bin/bun");
	});

	it("returns undefined when bun is nowhere", () => {
		expect(findBunBinary(options({ env: { PATH: "/usr/bin" } }))).toBeUndefined();
	});

	it("discovers bun.exe through PATHEXT on win32", () => {
		const opts = options({
			platform: "win32",
			homedir: "C:\\Users\\tester",
			env: { PATH: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT" },
			files: ["C:\\tools\\bun.EXE"],
		});
		expect(findBunBinary(opts)).toBe("C:\\tools\\bun.EXE");
	});

	it("prefers the win32 BUN_INSTALL bin bun.exe", () => {
		const opts = options({
			platform: "win32",
			homedir: "C:\\Users\\tester",
			env: { BUN_INSTALL: "C:\\bun", PATH: "C:\\tools", PATHEXT: ".EXE" },
			files: ["C:\\bun\\bin\\bun.exe", "C:\\tools\\bun.exe"],
		});
		expect(findBunBinary(opts)).toBe("C:\\bun\\bin\\bun.exe");
	});
});

describe("resolveBunReexec", () => {
	const bunTreeScript = "/opt/bun/install/global/node_modules/@code-yeongyu/senpi/dist/cli.js";

	it("stays when already running under bun", () => {
		const result = resolveBunReexec({
			scriptRealPath: bunTreeScript,
			versions: { bun: "1.2.3" },
			hasInheritedInspectorOption: false,
			options: options({ env: { BUN_INSTALL: "/opt/bun" }, files: ["/opt/bun/bin/bun"] }),
		});
		expect(result).toEqual({ action: "stay", reason: "already-bun" });
	});

	it("stays when SENPI_RUNTIME pins node, even inside the bun tree", () => {
		const result = resolveBunReexec({
			scriptRealPath: bunTreeScript,
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({
				env: { BUN_INSTALL: "/opt/bun", SENPI_RUNTIME: "node" },
				files: ["/opt/bun/bin/bun"],
			}),
		});
		expect(result).toEqual({ action: "stay", reason: "runtime-pinned-node" });
	});

	it("stays under an inherited inspector option so debugger sessions keep node", () => {
		const result = resolveBunReexec({
			scriptRealPath: bunTreeScript,
			versions: {},
			hasInheritedInspectorOption: true,
			options: options({
				env: { BUN_INSTALL: "/opt/bun", SENPI_RUNTIME: "bun" },
				files: ["/opt/bun/bin/bun"],
			}),
		});
		expect(result).toEqual({ action: "stay", reason: "inspector" });
	});

	it("re-execs when SENPI_RUNTIME requests bun and bun exists outside the tree", () => {
		const result = resolveBunReexec({
			scriptRealPath: "/usr/local/lib/node_modules/@code-yeongyu/senpi/dist/cli.js",
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({ env: { BUN_INSTALL: "/opt/bun", SENPI_RUNTIME: "bun" }, files: ["/opt/bun/bin/bun"] }),
		});
		expect(result).toEqual({ action: "reexec", bunPath: "/opt/bun/bin/bun" });
	});

	it("stays when SENPI_RUNTIME requests bun but no bun binary exists", () => {
		const result = resolveBunReexec({
			scriptRealPath: "/usr/local/lib/node_modules/@code-yeongyu/senpi/dist/cli.js",
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({ env: { BUN_INSTALL: "/opt/bun", SENPI_RUNTIME: "bun", PATH: "/usr/bin" } }),
		});
		expect(result).toEqual({ action: "stay", reason: "bun-not-found" });
	});

	it("re-execs a bun-tree script whose install root is reached through a symlink", () => {
		const result = resolveBunReexec({
			scriptRealPath: "/private/tmp/bunroot/install/global/node_modules/@code-yeongyu/senpi/dist/cli.js",
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({
				env: { BUN_INSTALL: "/tmp/bunroot" },
				files: ["/tmp/bunroot/bin/bun"],
				realpath: (path: string) => path.replace(/^\/tmp\//, "/private/tmp/"),
			}),
		});
		expect(result).toEqual({ action: "reexec", bunPath: "/tmp/bunroot/bin/bun" });
	});

	it("re-execs a script that lives in the bun global tree", () => {
		const result = resolveBunReexec({
			scriptRealPath: bunTreeScript,
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({ env: { BUN_INSTALL: "/opt/bun" }, files: ["/opt/bun/bin/bun"] }),
		});
		expect(result).toEqual({ action: "reexec", bunPath: "/opt/bun/bin/bun" });
	});

	it("re-execs the realpath of a ~/.bun/bin symlink resolved by the caller", () => {
		// `~/.bun/bin/senpi` is a symlink into the global tree; the caller passes the
		// already-realpathed target, which is what must be classified.
		const result = resolveBunReexec({
			scriptRealPath: "/home/tester/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/cli.js",
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({ homedir: "/home/tester", files: ["/home/tester/.bun/bin/bun"] }),
		});
		expect(result).toEqual({ action: "reexec", bunPath: "/home/tester/.bun/bin/bun" });
	});

	it("stays inside the bun tree when no bun binary is installed", () => {
		const result = resolveBunReexec({
			scriptRealPath: bunTreeScript,
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({ env: { BUN_INSTALL: "/opt/bun", PATH: "/usr/bin" } }),
		});
		expect(result).toEqual({ action: "stay", reason: "bun-not-found" });
	});

	it("stays for a plain node install outside the bun tree", () => {
		const result = resolveBunReexec({
			scriptRealPath: "/usr/local/lib/node_modules/@code-yeongyu/senpi/dist/cli.js",
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({ env: { BUN_INSTALL: "/opt/bun" }, files: ["/opt/bun/bin/bun"] }),
		});
		expect(result).toEqual({ action: "stay", reason: "not-bun-install" });
	});

	it("ignores an unknown SENPI_RUNTIME value and falls through to tree detection", () => {
		const result = resolveBunReexec({
			scriptRealPath: bunTreeScript,
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({ env: { BUN_INSTALL: "/opt/bun", SENPI_RUNTIME: "deno" }, files: ["/opt/bun/bin/bun"] }),
		});
		expect(result).toEqual({ action: "reexec", bunPath: "/opt/bun/bin/bun" });
	});

	it("re-execs a win32 bun-tree script with a bun.exe discovered through PATHEXT", () => {
		const result = resolveBunReexec({
			scriptRealPath: "C:\\Users\\tester\\.bun\\install\\global\\node_modules\\@code-yeongyu\\senpi\\dist\\cli.js",
			versions: {},
			hasInheritedInspectorOption: false,
			options: options({
				platform: "win32",
				homedir: "C:\\Users\\tester",
				env: { PATH: "C:\\tools", PATHEXT: ".EXE" },
				files: ["C:\\Users\\tester\\.bun\\bin\\bun.exe"],
			}),
		});
		expect(result).toEqual({ action: "reexec", bunPath: "C:\\Users\\tester\\.bun\\bin\\bun.exe" });
	});
});
