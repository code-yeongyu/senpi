import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const NPMRC_CARRIED_KEY = /^(?:registry|@[^\s=:/]+:registry|strict-ssl|ca|cafile)$/;

/**
 * A revision carries forward only the registry settings of its `.npmrc`: `registry`, `@scope:registry`, `strict-ssl`,
 * `ca` and `cafile`. Every other key, credentials included, is dropped by default, and the file is rewritten as a
 * regular file: a symlinked `.npmrc` is replaced, never written through, so the file it pointed at stays untouched.
 */
export async function carryNpmrcSettings(root: string): Promise<void> {
	const path = join(root, ".npmrc");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		await rm(path, { recursive: true, force: true });
		return;
	}
	const kept = text
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => {
			const key = line.split("=", 1)[0]?.trim() ?? "";
			return line.includes("=") && NPMRC_CARRIED_KEY.test(key);
		})
		.flatMap((line) => {
			const carried = withoutUrlCredentials(line);
			return carried === undefined ? [] : [carried];
		});
	await rm(path, { recursive: true, force: true });
	if (kept.length > 0) await writeFile(path, `${kept.join("\n")}\n`, { mode: 0o600, flag: "wx" });
}

/**
 * The `file:` and absolute path specs a revision's `package.json` already records, as written (npm writes a relative
 * `file:../..` path) and resolved against the revision: the installer echoes them on every later install.
 */
export async function recordedFileSpecs(root: string): Promise<string[]> {
	try {
		const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) return [];
		const dependencies = manifest.dependencies;
		if (typeof dependencies !== "object" || dependencies === null) return [];
		return Object.values(dependencies).flatMap((spec) => {
			if (typeof spec !== "string") return [];
			if (spec.startsWith("file:")) {
				const path = spec.slice("file:".length);
				return isAbsolute(path) ? [path] : [path, resolve(root, path)];
			}
			return isAbsolute(spec) ? [spec] : [];
		});
	} catch {
		return [];
	}
}

/**
 * A carried `registry`/`@scope:registry` value keeps only its scheme, host and path: user info, a query and a fragment
 * can each carry a credential, so they are cleared with the WHATWG URL parser npm itself uses. The path is kept, since
 * registries are addressed by it, so a registry that embeds a token in its path keeps it in the revision's private
 * (0600, in a 0700 directory) copy. A value that does not parse is dropped, and so is one that names an environment
 * variable (`${...}`): npm expands it at install time, and a parsed copy would be a different URL. Other carried keys
 * pass unchanged.
 */
function withoutUrlCredentials(line: string): string | undefined {
	const separator = line.indexOf("=");
	const key = line.slice(0, separator).trim();
	if (!key.endsWith("registry")) return line;
	const raw = line.slice(separator + 1).trim();
	if (raw.includes("${")) return undefined;
	const quote = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.endsWith(raw[0]) ? raw[0] : "";
	let url: URL;
	try {
		url = new URL(quote === "" ? raw : raw.slice(1, -1));
	} catch {
		return undefined;
	}
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return `${key}=${quote}${url.href}${quote}`;
}

/** Without its own `package.json`, bun walks up from the revision and installs into the nearest one above it. */
export async function seedPackageJson(root: string): Promise<void> {
	await writeFile(join(root, "package.json"), '{"private":true}\n', { flag: "wx" }).catch((error: unknown) => {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	});
}
