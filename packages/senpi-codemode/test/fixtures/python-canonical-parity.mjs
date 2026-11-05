import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createPathIdentity, PATH_IDENTITY_VERSION } from "../../src/kernels/shared/path-identity.mjs";

const [python, cwd, serialized, raw = ""] = process.argv.slice(2);
const rows = JSON.parse(serialized);
const primitives = {
	realpathNative: realpathSync.native,
	lstat: lstatSync,
	readlink: readlinkSync,
	pathApi: { join, dirname, basename, isAbsolute, sep, win32Resolve: win32.resolve },
	platform: process.platform,
};
const identity = createPathIdentity(primitives);
function canonical(instance, path) {
	try {
		return { canonical: { v: PATH_IDENTITY_VERSION, ...instance.canonical(path, cwd) } };
	} catch (error) {
		return { unresolvable: typeof error?.code === "string" ? error.code : "EUNKNOWN" };
	}
}
const js = rows.map((path) => canonical(identity, path));
const freshJs = rows.map((path) => canonical(createPathIdentity(primitives), path));
const asset = fileURLToPath(new URL("../../src/kernels/py/path_identity.py", import.meta.url));
const code = [
	"import json, os, sys",
	"if sys.argv[4] == 'invalid-native':",
	"    import ctypes",
	"    ctypes.string_at = lambda pointer: b'\\xff'",
	"namespace = {'__file__': sys.argv[1]}",
	"with open(sys.argv[1], 'rb') as source:",
	"    exec(compile(source.read(), sys.argv[1], 'exec'), namespace)",
	"identity = namespace['create_identity'](sys.argv[2])",
	"paths = [p if sys.argv[4] == 'raw' or os.path.isabs(p) else os.path.join(os.getcwd(), p)",
	"         for p in json.loads(sys.argv[3])]",
	"print(json.dumps({'shared': [identity(p) for p in paths],",
	"    'fresh': [namespace['create_identity'](sys.argv[2])(p) for p in paths]}))",
].join("\n");
const py = JSON.parse(
	execFileSync(python, ["-c", code, asset, process.versions.bun ? "bun" : "node", serialized, raw], {
		cwd,
		encoding: "utf8",
		timeout: 20_000,
	}),
);
console.log(JSON.stringify({ js, py: py.shared, freshJs, freshPy: py.fresh }));
