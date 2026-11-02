import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const BUILD_WHEEL = `
import sys, zipfile
out, name, version, *requires = sys.argv[1:]
dist = f"{name}-{version}.dist-info"
path = f"{out}/{name}-{version}-py3-none-any.whl"
metadata = f"Metadata-Version: 2.1\\nName: {name}\\nVersion: {version}\\n" + "".join(f"Requires-Dist: {r}\\n" for r in requires)
files = {
    f"{name}/__init__.py": f"VERSION = {version!r}\\n",
    f"{dist}/METADATA": metadata,
    f"{dist}/WHEEL": "Wheel-Version: 1.0\\nGenerator: senpi-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
files[f"{dist}/RECORD"] = "".join(f"{p},,\\n" for p in files) + f"{dist}/RECORD,,\\n"
with zipfile.ZipFile(path, "w") as wheel:
    for p, body in files.items():
        wheel.writestr(p, body)
print(path)
`;

export function hasPythonWithPip(): boolean {
	return spawnSync("python3", ["-m", "pip", "--version"], { stdio: "ignore" }).status === 0;
}

export function buildWheel(dir: string, name: string, version: string, requires: readonly string[] = []): string {
	return execFileSync("python3", ["-c", BUILD_WHEEL, dir, name, version, ...requires], { encoding: "utf8" }).trim();
}

export function importFrom(root: string, module: string): string {
	return execFileSync(
		"python3",
		[
			"-s",
			"-c",
			`import sys; sys.path.insert(0, ${JSON.stringify(root)}); import ${module}; print(${module}.VERSION)`,
		],
		{ encoding: "utf8" },
	).trim();
}

export function siteFilesSnapshot(): string {
	return execFileSync(
		"python3",
		[
			"-c",
			`import os, site
roots = [*site.getsitepackages(), site.getusersitepackages()]
for root in roots:
    for dirpath, _dirs, names in os.walk(root):
        for name in sorted(names):
            path = os.path.join(dirpath, name)
            info = os.lstat(path)
            print(path, info.st_size, info.st_mtime_ns)`,
		],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
}

export const fixtureDir = (root: string) => join(root, "wheels");

/** A build backend with just the PEP 660 hooks, so pip can make a real editable install offline. */
export const editableBackend = `import base64, hashlib, os, zipfile

def _record_line(path, data):
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    return f"{path},sha256={digest},{len(data)}"

def get_requires_for_build_editable(config_settings=None):
    return []

def prepare_metadata_for_build_editable(metadata_directory, config_settings=None):
    info = os.path.join(metadata_directory, "senpi_editable-1.0.dist-info")
    os.makedirs(info, exist_ok=True)
    with open(os.path.join(info, "METADATA"), "w") as f:
        f.write("Metadata-Version: 2.1\\nName: senpi-editable\\nVersion: 1.0\\n")
    return "senpi_editable-1.0.dist-info"

def build_editable(wheel_directory, config_settings=None, metadata_directory=None):
    name = "senpi_editable-1.0-py3-none-any.whl"
    files = {
        "senpi_editable.pth": (os.path.abspath(".") + "\\n").encode(),
        "senpi_editable-1.0.dist-info/METADATA": b"Metadata-Version: 2.1\\nName: senpi-editable\\nVersion: 1.0\\n",
        "senpi_editable-1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\\nGenerator: senpi-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
    }
    record = "senpi_editable-1.0.dist-info/RECORD"
    with zipfile.ZipFile(os.path.join(wheel_directory, name), "w") as z:
        lines = []
        for path, data in files.items():
            z.writestr(path, data)
            lines.append(_record_line(path, data))
        lines.append(record + ",,")
        z.writestr(record, "\\n".join(lines) + "\\n")
    return name
`;
