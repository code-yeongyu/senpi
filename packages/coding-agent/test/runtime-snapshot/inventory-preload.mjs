import fs from "node:fs";
import Module, { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// Observe resolution, not source text. Append synchronously because --help uses process.exit.
const output = process.env.SENPI_INVENTORY_LOG;
const append = fs.appendFileSync;
const seen = new Set();
function record(value) {
	if (typeof value !== "string") return;
	const path = value.startsWith("file:") ? fileURLToPath(value) : value;
	if (!path.replaceAll("\\", "/").includes("/node_modules/") || seen.has(path)) return;
	seen.add(path);
	append(output, `${JSON.stringify(path)}\n`);
}

if (typeof Module.registerHooks === "function") {
	Module.registerHooks({
		resolve(specifier, context, next) {
			const result = next(specifier, context);
			record(result.url);
			return result;
		},
	});
}
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (...args) {
	const result = resolveFilename.apply(this, args);
	record(result);
	return result;
};

// jiti and Bun's extension graph read/transpile sources themselves. Also capture runtime assets.
const read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
	const result = read.call(this, path, ...args);
	record(path instanceof URL ? path.href : path);
	return result;
};
syncBuiltinESMExports();

if (typeof Bun !== "undefined") {
	const resolve = Bun.resolveSync;
	Bun.resolveSync = function (...args) {
		const result = resolve.apply(this, args);
		record(result);
		return result;
	};
	Bun.plugin({
		name: "runtime-snapshot-inventory",
		setup(build) {
			build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, (args) => {
				record(args.path);
				const loader = args.path.endsWith(".tsx")
					? "tsx"
					: args.path.endsWith(".jsx")
						? "jsx"
						: /\.[cm]?ts$/.test(args.path)
							? "ts"
							: "js";
				return { contents: read(args.path, "utf8"), loader };
			});
		},
	});
}
