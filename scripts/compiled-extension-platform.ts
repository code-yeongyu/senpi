export function compiledExtensionPlatform(platform: NodeJS.Platform, arch: string) {
	return {
		target: `${platform === "win32" ? "windows" : platform}-${arch === "x64" ? "x64" : "arm64"}`,
		executable: platform === "win32" ? "pi.exe" : "pi",
		pathSuffix: platform === "win32" ? " # % " : " # % ? ",
	};
}
