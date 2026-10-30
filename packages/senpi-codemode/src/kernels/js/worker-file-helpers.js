import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

export function createFileHelpers(options, emit) {
	const roots = { ...options.localRoots };
	if (options.artifactsDir && !roots.local) roots.local = join(options.artifactsDir, "local");
	const resolvePath = (raw, operation) => {
		const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/iu.exec(raw);
		if (!match) return isAbsolute(raw) ? normalize(raw) : resolve(options.cwd, raw);
		const scheme = match[1].toLowerCase();
		const root = roots[scheme];
		if (!root) throw new Error(`Protocol paths are not supported by ${operation}(): ${raw}`);
		let relative;
		try { relative = decodeURIComponent(match[2].replaceAll("\\", "/")); }
		catch (error) {
			if (error instanceof URIError) throw new Error(`Invalid URL encoding in ${scheme}:// path: ${raw}`);
			throw error;
		}
		if (isAbsolute(relative) || relative.split("/").includes("..")) throw new Error(`Path traversal is not allowed in ${scheme}:// URLs: ${raw}`);
		const rootPath = resolve(root);
		const path = resolve(rootPath, relative);
		if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`)) throw new Error(`${scheme}:// path escapes its root`);
		return path;
	};
	return {
		async read(rawPath, settings) {
			const path = resolvePath(String(rawPath), "read");
			const info = await stat(path);
			if (info.isDirectory()) throw new Error(`Directory paths are not supported by read(): ${path}`);
			let text = options.permissionIO
				? await options.permissionIO.read(String(rawPath), path) : await readFile(path, "utf8");
			const offset = typeof settings.offset === "number" ? settings.offset : 1;
			const limit = typeof settings.limit === "number" ? settings.limit : undefined;
			if (offset > 1 || limit !== undefined) {
				const start = Math.max(0, offset - 1);
				text = text.split(/\r?\n/u).slice(start, limit === undefined ? undefined : start + limit).join("\n");
			}
			emit({ op: "read", path, bytes: info.size, chars: text.length });
			return text;
		},
		async write(rawPath, content) {
			const path = resolvePath(String(rawPath), "write");
			const data = await writeData(content);
			if (options.permissionIO) await options.permissionIO.write(String(rawPath), path, data);
			else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, data); }
			emit({ op: "write", path, bytes: typeof data === "string" ? Buffer.byteLength(data) : data.byteLength });
			return path;
		},
	};
}

async function writeData(value) {
	if (typeof value === "string" || value instanceof Uint8Array) return value;
	if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError("write() expects string, Blob, ArrayBuffer, or TypedArray data");
}
