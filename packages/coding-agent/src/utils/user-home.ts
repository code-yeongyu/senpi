import { homedir } from "node:os";

/**
 * The user's home the way Node's `os.homedir()` answers it on every call: `$HOME` (`USERPROFILE` on Windows) when set
 * and non-empty, else the account's home. Bun's `os.homedir()` keeps the value it read at startup, so code that must
 * follow a runtime change of the variable (an embedding host, a test harness) reads it here and both runtimes agree
 * (code-yeongyu/senpi#5822).
 */
export function userHomeDir(): string {
	const fromEnv = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	return fromEnv ? fromEnv : homedir();
}
