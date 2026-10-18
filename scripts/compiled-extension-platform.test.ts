import { expect, test } from "bun:test";
import { compiledExtensionPlatform } from "./compiled-extension-platform.ts";

for (const arch of ["x64", "arm64"]) {
	test(`selects a build-script target and legal fixture paths when running on Windows ${arch}`, () => {
		// Given / When
		const platform = compiledExtensionPlatform("win32", arch);
		// Then: machine-consumed CLI values and filesystem constraints.
		expect(platform.target).toBe(`windows-${arch}`);
		expect(platform.executable).toBe("pi.exe");
		expect(platform.pathSuffix).not.toMatch(/[<>:"/\\|?*]/);
	});
}
