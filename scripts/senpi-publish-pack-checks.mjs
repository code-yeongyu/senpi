import { ownedRegistryAliases } from "./prepare-senpi-publish-manifest.mjs";
import { isUnpublishedForkPackage } from "./registry-packages.mjs";

const SUPPORTED_NATIVE_PREBUILD_TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
];

export function nativePrebuildTarget(platform = process.platform, arch = process.arch) {
	const target = `${platform}-${arch}`;
	if (!SUPPORTED_NATIVE_PREBUILD_TARGETS.includes(target)) {
		throw new Error(`Unsupported native prebuild target: ${target}`);
	}
	return target;
}

// Each native workspace vendors its host prebuild under its own file name.
const NATIVE_PREBUILD_FILE_NAMES = new Map([["@earendil-works/pi-pty", (target) => `senpi_pty.${target}.node`]]);

export function nativePrebuildFile(target, packageName) {
	const fileName = NATIVE_PREBUILD_FILE_NAMES.get(packageName);
	if (!fileName) {
		throw new Error(`No native prebuild file pattern for ${packageName}`);
	}
	return `native/prebuilds/${target}/${fileName(target)}`;
}

// Loader-visible files every published fork workspace must carry, keyed by source package
// name. senpi resolves these packages from the registry, so each one's own tarball is the
// copy the runtime loads.
const publishedWorkspaceRequiredFiles = new Map([
	// The agent-core dist reaches its own tree-sitter grammars through compile-time
	// `type: "file"` imports; a tarball without `assets/` breaks `bun build --compile`
	// for every consumer (issue #1800).
	[
		"@earendil-works/pi-agent-core",
		["package.json", "dist/index.js", "assets/tree-sitter/javascript.wasm", "assets/tree-sitter/web-tree-sitter.wasm"],
	],
	["@earendil-works/pi-ai", ["package.json", "dist/index.js"]],
	["@earendil-works/pi-pty", ["package.json", "dist/index.js", "native/index.js"]],
	["@earendil-works/pi-tui", ["package.json", "dist/index.js"]],
	["@earendil-works/pi-telemetry", ["package.json", "dist/index.js"]],
	[
		"@code-yeongyu/senpi-codemode",
		["package.json", "src/index.ts", "src/kernels/py/prelude.py", "README.md", "CHANGELOG.md", "LICENSE"],
	],
]);

function publishedWorkspacePackageChecks() {
	const nativeTargets = [nativePrebuildTarget()];
	return [...publishedWorkspaceRequiredFiles].map(([packageName, requiredFiles]) => {
		const prebuildFiles = NATIVE_PREBUILD_FILE_NAMES.has(packageName)
			? nativeTargets.map((target) => nativePrebuildFile(target, packageName))
			: [];
		return { packageName, requiredFiles: [...requiredFiles, ...prebuildFiles], prebuildFiles };
	});
}

// `npm pack --json` file paths vary by npm version: some emit a `package/` prefix, others
// bare package-relative paths. Normalize to the bare form.
function packedFilePaths(packed) {
	return new Set((packed.files ?? []).map((file) => file.path.replace(/^package\//, "")));
}

// Published sourcemaps reference workspace sources that are never published, so they cannot
// resolve for consumers and only add install size (senpi#2362).
function assertNoSourcemaps(filePaths, packageName) {
	const maps = [...filePaths].filter((path) => path.endsWith(".map"));
	if (maps.length > 0) {
		throw new Error(`${packageName} package tarball must not ship sourcemaps (found ${maps.length}, e.g. ${maps[0]})`);
	}
}

export function assertPublishedWorkspacePackFiles(packed, sourcePackageName, options = {}) {
	const requiredNativePrebuildTargets = options.requiredNativePrebuildTargets ?? [];
	for (const target of requiredNativePrebuildTargets) {
		if (!SUPPORTED_NATIVE_PREBUILD_TARGETS.includes(target)) {
			throw new Error(`Unsupported native prebuild target: ${target}`);
		}
	}
	const check = publishedWorkspacePackageChecks().find(
		(candidate) => candidate.packageName === sourcePackageName,
	);
	const filePaths = packedFilePaths(packed);
	assertNoSourcemaps(filePaths, sourcePackageName);
	if (!check) return;
	const missing = [];
	for (const requiredFile of check.requiredFiles) {
		if (filePaths.has(requiredFile)) continue;
		// The platform native prebuild is optional: the pty loader falls back to a
		// child_process pipe when it is absent, so a publish runner without a committed or
		// built prebuild for its own platform must not fail the pack check.
		if (check.prebuildFiles.includes(requiredFile)) {
			console.warn(`Warning: packed ${sourcePackageName} has no native prebuild ${requiredFile} (runtime fallback applies).`);
			continue;
		}
		missing.push(requiredFile);
	}
	if (missing.length > 0) {
		throw new Error(`${sourcePackageName} package tarball is missing loader-visible files: ${missing.join(", ")}`);
	}
	// A publish that explicitly requires release-built targets (the publish-only run of
	// publish-npm.yml) must never ship a tarball that leaves those platforms on the pipe
	// fallback; every other target keeps the warn-only fallback above (senpi#1193).
	for (const target of requiredNativePrebuildTargets) {
		if (!NATIVE_PREBUILD_FILE_NAMES.has(sourcePackageName)) continue;
		const prebuild = nativePrebuildFile(target, sourcePackageName);
		if (filePaths.has(prebuild)) continue;
		throw new Error(`${sourcePackageName} package tarball is missing ${prebuild}; the publish requires this native prebuild. Stage packages/pty/native/prebuilds/${target}/ before publishing.`);
	}
}

const vendoredRequiredFiles = ["vendor/pi-client/index.js", "vendor/pi-client/index.d.ts", "vendor/pi-protocol/index.js", "vendor/pi-protocol/index.d.ts"];

export function assertSenpiPackedWorkspaceFiles(packed, manifest) {
	const filePaths = packedFilePaths(packed);
	// The tarball ships no dependency tree: every runtime dependency is a registry edge.
	const shippedNodeModules = [...filePaths].find((path) => path === "node_modules" || path.startsWith("node_modules/") || path.includes("/node_modules/"));
	if (shippedNodeModules) {
		throw new Error(`senpi package tarball must not ship node_modules (found ${shippedNodeModules}); dependencies resolve from the registry.`);
	}
	// npm ALWAYS packs a file literally named npm-shrinkwrap.json (files[] cannot exclude
	// it), and a shipped shrinkwrap overrides consumer resolution of the whole tree.
	const shippedShrinkwrap = [...filePaths].find((path) => path === "npm-shrinkwrap.json" || path.endsWith("/npm-shrinkwrap.json"));
	if (shippedShrinkwrap) {
		throw new Error(`senpi package tarball must not ship npm-shrinkwrap.json (found ${shippedShrinkwrap}).`);
	}
	assertNoSourcemaps(filePaths, "senpi");
	if (manifest.bundleDependencies !== undefined || manifest.bundledDependencies !== undefined) {
		throw new Error("senpi publish manifest must not declare bundleDependencies; dependencies resolve from the registry.");
	}
	const declared = ["dependencies", "optionalDependencies"].flatMap((field) => Object.entries(manifest[field] ?? {}));
	const unpublished = declared.map(([name]) => name).filter(isUnpublishedForkPackage);
	if (unpublished.length > 0) {
		throw new Error(`senpi package manifest declares packages that are never published, which bun cannot install (senpi#2141): ${unpublished.join(", ")}`);
	}
	const unaliased = declared.filter(([name, spec]) => ownedRegistryAliases.has(name) && !spec.startsWith(`npm:${ownedRegistryAliases.get(name)}@`));
	if (unaliased.length > 0) {
		throw new Error(`senpi package manifest must reach fork workspaces through their published aliases: ${unaliased.map(([name, spec]) => `${name}=${spec}`).join(", ")}`);
	}
	const missing = vendoredRequiredFiles.filter((path) => !filePaths.has(path));
	if (missing.length > 0) {
		throw new Error(`senpi package tarball is missing vendored workspace files: ${missing.join(", ")}`);
	}
}
