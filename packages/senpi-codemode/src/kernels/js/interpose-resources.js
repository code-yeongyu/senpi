import { checkPath, replaceMethod } from "./interpose-paths.js";

const { constants } = process.getBuiltinModule("node:fs");

function openModes(flags = "r") {
	flags ??= "r";
	if (typeof flags === "number") {
		const access = flags & (constants.O_RDONLY | constants.O_WRONLY | constants.O_RDWR);
		if (access === constants.O_WRONLY) return ["write"];
		return access === constants.O_RDWR || (flags & (constants.O_CREAT | constants.O_TRUNC)) !== 0 ? ["read", "write"] : ["read"];
	}
	return flags.includes("+") ? ["read", "write"] : /^[wax]/u.test(flags) ? ["write"] : ["read"];
}

export function createResourceTable(check) {
	const descriptors = new Map();
	const objects = new WeakMap();
	const table = (resource) => typeof resource === "number" ? descriptors : objects;
	const record = (resource, path, modes) => {
		if (typeof resource === "number" || (resource !== null && typeof resource === "object")) {
			table(resource).set(resource, { path, modes });
		}
		return resource;
	};
	const forget = (resource) => table(resource).delete(resource);
	const use = (resource, mode) => {
		check(() => {
			const grant = table(resource).get(resource);
			return { granted: true, unsupported: !grant || (mode !== undefined && !grant.modes.includes(mode)) };
		});
	};
	const path = (resource) => table(resource).get(resource)?.path;
	const open = (file, flags) => {
		const modes = openModes(flags);
		for (const mode of modes) checkPath(check, mode === "read" ? "read" : "write", file);
		return modes;
	};
	const handle = (value, file, modes) => {
		record(value, file, modes);
		record(value.fd, file, modes);
		for (const [mode, names] of [
			["read", ["read", "readv", "readFile", "readLines", "createReadStream", "readableWebStream"]],
			["write", ["write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes", "sync", "datasync", "createWriteStream"]],
		]) {
			for (const name of names) replaceMethod(value, name, (original) => function (...args) {
				use(this, mode);
				const result = original.apply(this, args);
				if (/Stream$/u.test(name)) record(result, file, [mode]);
				return result;
			});
		}
		replaceMethod(value, "close", (original) => function (...args) {
			const fd = this.fd;
			return original.apply(this, args).then((result) => { forget(fd); forget(this); return result; });
		});
		return value;
	};
	return { record, forget, use, path, open, handle };
}
