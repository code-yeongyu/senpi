import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyRoots } from "../src/core/extensions/builtin/moved-path-guard/known-moves.ts";
import { userHomeDir } from "../src/utils/user-home.ts";

// Bun's `os.homedir()` keeps the home it read at startup, while Node's re-reads `$HOME` (`USERPROFILE` on Windows) on
// every call (code-yeongyu/senpi#5822). The mock answers like Bun does on either runtime, so the moved-path guard
// must follow the variable itself.
const STARTUP_HOME = join("/", "startup-home");
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => STARTUP_HOME, default: { ...actual, homedir: () => STARTUP_HOME } };
});

const HOME_VAR = process.platform === "win32" ? "USERPROFILE" : "HOME";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the user's home follows a runtime $HOME change on every runtime", () => {
	it("the moved-path guard's legacy roots sit under the home the variable names now", () => {
		const home = join("/", "changed-home");
		vi.stubEnv(HOME_VAR, home);

		expect(userHomeDir()).toBe(home);
		expect(legacyRoots()).toEqual([join(home, ".t3"), join(home, ".omo-app")]);
	});

	it("an unset or empty variable falls back to the account's home", () => {
		vi.stubEnv(HOME_VAR, "");

		expect(userHomeDir()).toBe(STARTUP_HOME);
	});
});
