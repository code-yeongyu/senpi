import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function digestTree(root) {
	const hash = createHash("sha256");
	let rootStat;
	try {
		rootStat = lstatSync(root);
	} catch (error) {
		if (error?.code === "ENOENT") return hash.update("missing").digest("hex");
		throw error;
	}

	const entries = [];
	const collect = (path, relative, stat) => {
		const type = entryType(stat);
		entries.push({ path, relative, type, target: type === "symlink" ? readlinkSync(path) : undefined });
		if (type === "directory") {
			for (const name of readdirSync(path)) {
				const childPath = join(path, name);
				collect(childPath, relative === "." ? name : join(relative, name), lstatSync(childPath));
			}
		}
	};

	if (rootStat.isDirectory()) {
		for (const name of readdirSync(root)) {
			const path = join(root, name);
			collect(path, name, lstatSync(path));
		}
	} else {
		collect(root, ".", rootStat);
	}

	for (const entry of entries.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)) {
		updateField(hash, entry.relative);
		updateField(hash, entry.type);
		if (entry.type === "symlink") updateField(hash, entry.target);
		if (entry.type === "file") updateField(hash, readFileSync(entry.path));
	}
	return hash.digest("hex");
}

function updateField(hash, value) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
	hash.update(`${bytes.length}:`);
	hash.update(bytes);
}

function entryType(stat) {
	if (stat.isFile()) return "file";
	if (stat.isDirectory()) return "directory";
	if (stat.isSymbolicLink()) return "symlink";
	if (stat.isBlockDevice()) return "block-device";
	if (stat.isCharacterDevice()) return "character-device";
	if (stat.isFIFO()) return "fifo";
	if (stat.isSocket()) return "socket";
	return "unknown";
}
