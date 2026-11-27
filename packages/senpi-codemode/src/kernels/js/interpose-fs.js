import { checkPath, executionPath, replaceMethod } from "./interpose-paths.js";
import { createResourceTable } from "./interpose-resources.js";

export const FS_PERMISSION_PATHS = new Set([
	"writeFile", "appendFile", "truncate", "mkdir", "mkdtemp", "rm", "rmdir", "unlink",
	"symlink", "chmod", "chown", "lchmod", "lchown", "utimes", "lutimes", "rename", "link", "copyFile", "cp",
	"readFile", "readlink", "realpath", "readdir", "opendir", "open", "openAsBlob",
	"createReadStream", "createWriteStream",
]);

export function installFilesystemPermissions(check) {
	const fs = process.getBuiltinModule("node:fs");
	const resources = createResourceTable(check);
	const promises = [...new Set([fs.promises, process.getBuiltinModule("node:fs/promises")])];
	const decisions = {
		writeFile: [[0, "write"]], appendFile: [[0, "write"]], truncate: [[0, "write"]],
		mkdir: [[0, "write"]], mkdtemp: [[0, "write"]], rm: [[0, "write"]], rmdir: [[0, "write"]],
		unlink: [[0, "write"]], symlink: [[1, "write"]], chmod: [[0, "write"]], chown: [[0, "write"]],
		lchmod: [[0, "write"]], lchown: [[0, "write"]],
		utimes: [[0, "write"]], lutimes: [[0, "write"]], rename: [[0, "write"], [1, "write"]],
		link: [[0, "write"], [1, "write"]], copyFile: [[0, "read"], [1, "write"]], cp: [[0, "read"], [1, "write"]],
		readFile: [[0, "read"]], readlink: [[0, "read"]], realpath: [[0, "read"]],
		readdir: [[0, "ls"]], opendir: [[0, "ls"]], openAsBlob: [[0, "read"]],
	};
	const guard = (original, entries) => function (...args) {
		const actual = [...args];
		for (const [index, tool] of entries) {
			const value = args[index];
			if (typeof value === "number" || (value !== null && typeof value === "object" && typeof value.fd === "number")) {
				resources.use(value, tool === "write" ? "write" : "read");
			} else {
				checkPath(check, tool, value);
				actual[index] = executionPath(value);
			}
		}
		return original.apply(this, actual);
	};
	for (const [name, entries] of Object.entries(decisions)) {
		replaceMethod(fs, name, (original) => guard(original, entries));
		replaceMethod(fs, `${name}Sync`, (original) => guard(original, entries));
		for (const owner of promises) replaceMethod(owner, name, (original) => guard(original, entries));
	}
	replaceMethod(fs.realpath, "native", (original) => guard(original, [[0, "read"]]));
	replaceMethod(fs.realpathSync, "native", (original) => guard(original, [[0, "read"]]));
	for (const owner of [fs, ...promises]) {
		for (const name of ["glob", "globSync"]) replaceMethod(owner, name, (original) => function (pattern, ...args) {
			const options = args[0];
			const cwd = options && typeof options === "object" ? options.cwd ?? process.cwd() : process.cwd();
			checkPath(check, "ls", cwd);
			const effective = options && typeof options === "object" ? { ...options, cwd: executionPath(cwd) } : { cwd: process.cwd() };
			return typeof options === "function"
				? original.call(this, pattern, effective, ...args)
				: original.call(this, pattern, effective, ...args.slice(1));
		});
	}
	replaceMethod(fs, "openSync", (original) => function (file, flags, ...args) {
		const modes = resources.open(file, flags);
		return resources.record(original.call(this, executionPath(file), flags, ...args), file, modes);
	});
	replaceMethod(fs, "open", (original) => function (file, flags, ...args) {
		if (typeof flags === "function") { args = [flags]; flags = undefined; }
		const modes = resources.open(file, flags);
		const callback = args.at(-1);
		if (typeof callback !== "function") return original.call(this, executionPath(file), flags, ...args);
		return original.call(this, executionPath(file), flags, ...args.slice(0, -1), (error, fd) => {
			if (!error) resources.record(fd, file, modes);
			callback(error, fd);
		});
	});
	for (const owner of promises) replaceMethod(owner, "open", (original) => function (file, flags, ...args) {
		const modes = resources.open(file, flags);
		return original.call(this, executionPath(file), flags, ...args).then((handle) => resources.handle(handle, file, modes));
	});
	for (const [mode, names] of [
		["read", ["read", "readv"]],
		["write", ["write", "writev", "ftruncate", "fchmod", "fchown", "futimes", "fsync", "fdatasync"]],
	]) {
		for (const name of names) {
			for (const key of [name, `${name}Sync`]) replaceMethod(fs, key, (original) => function (fd, ...args) {
				resources.use(fd, mode);
				return original.call(this, fd, ...args);
			});
		}
	}
	replaceMethod(fs, "closeSync", (original) => function (fd, ...args) {
		resources.use(fd);
		const result = original.call(this, fd, ...args);
		resources.forget(fd);
		return result;
	});
	replaceMethod(fs, "close", (original) => function (fd, callback) {
		resources.use(fd);
		return original.call(this, fd, (error) => { if (!error) resources.forget(fd); callback(error); });
	});
	for (const [name, mode] of [["createReadStream", "read"], ["createWriteStream", "write"]]) {
		replaceMethod(fs, name, (original) => function (file, options) {
			const fd = options?.fd;
			if (fd != null) resources.use(fd, mode);
			else checkPath(check, mode, file);
			const stream = original.call(this, executionPath(file), options);
			resources.record(stream, file, [mode]);
			stream.once("open", (descriptor) => resources.record(descriptor, file, [mode]));
			const methods = mode === "write" ? ["write", "end"] : ["read"];
			for (const method of methods) replaceMethod(stream, method, (fn) => function (...args) {
				resources.use(stream, mode);
				return fn.apply(this, args);
			});
			return stream;
		});
	}
	const protectBlob = (blob, file) => {
		resources.record(blob, file, ["read"]);
		for (const name of ["text", "bytes", "arrayBuffer", "stream", "slice"]) replaceMethod(blob, name, (fn) => function (...params) {
			resources.use(this, "read");
			const value = fn.apply(this, params);
			return name === "slice" ? protectBlob(value, file) : value;
		});
		return blob;
	};
	replaceMethod(fs, "openAsBlob", (original) => function (file, ...args) {
		return original.call(this, file, ...args).then((blob) => protectBlob(blob, file));
	});
	return resources;
}
