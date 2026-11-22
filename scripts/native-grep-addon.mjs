// The senpi-grep N-API addon the native probe tests load (#3978).
//
// CI builds it once, in a named step with the Rust cache, and exports SENPI_GREP_NATIVE_PATH.
// A CI run without that path is a workflow mistake: it fails at once with a message naming the
// missing step, instead of a cold release build inside a test hook that can outrun its timeout.
// Local runs may still build it in place.

export const CI_BUILD_STEP = "Build native grep addon";

/**
 * @param {{ env: Record<string, string | undefined>, localAddon: string | undefined }} input
 * @returns {{ kind: "path", path: string } | { kind: "local", file: string } | { kind: "build" } | { kind: "missing-in-ci", message: string }}
 */
export function resolveNativeGrepAddon({ env, localAddon }) {
	if (env.SENPI_GREP_NATIVE_PATH) return { kind: "path", path: env.SENPI_GREP_NATIVE_PATH };
	if (localAddon) return { kind: "local", file: localAddon };
	if (env.CI === "true" || env.CI === "1") {
		return {
			kind: "missing-in-ci",
			message: `SENPI_GREP_NATIVE_PATH is not set in CI. The workflow must build the senpi-grep addon in its "${CI_BUILD_STEP}" step and export the path before the script tests run (#3978).`,
		};
	}
	return { kind: "build" };
}
