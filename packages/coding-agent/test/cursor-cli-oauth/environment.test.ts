import { describe, expect, it } from "vitest";
import {
	CURSOR_AGENT_ENVIRONMENT_PASSTHROUGH,
	cursorAgentEnvironment,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/environment.ts";

describe("cursorAgentEnvironment", () => {
	it("pins the passthrough allowlist the transport contract documents", () => {
		expect([...CURSOR_AGENT_ENVIRONMENT_PASSTHROUGH]).toEqual(["PATH", "TERM", "LANG", "LC_ALL", "FORCE_COLOR"]);
	});

	it("builds the child environment from HOME, the file credential store, and the allowlist only", () => {
		const env = cursorAgentEnvironment("/accounts/default/home", {
			PATH: "/usr/bin",
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			FORCE_COLOR: "1",
			HOME: "/Users/host",
			AGENT_CLI_CREDENTIAL_STORE: "keychain",
			SSH_CONNECTION: "10.0.0.1 50000 10.0.0.2 22",
			SSH_CLIENT: "10.0.0.1 50000 22",
			SSH_TTY: "/dev/ttys000",
			MOSH_SERVER: "1",
			VSCODE_SSH_HOST: "remote",
			CURSOR_AGENT_CLI_ASSUME_SSH: "1",
			SENPI_TRANSPORT_SECRET: "must-not-leak",
		});

		expect(env).toEqual({
			HOME: "/accounts/default/home",
			AGENT_CLI_CREDENTIAL_STORE: "file",
			PATH: "/usr/bin",
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			FORCE_COLOR: "1",
		});
	});

	it("omits allowlisted variables the parent does not define instead of passing undefined", () => {
		const env = cursorAgentEnvironment("/home", { PATH: "/bin" });
		expect(Object.keys(env).sort()).toEqual(["AGENT_CLI_CREDENTIAL_STORE", "HOME", "PATH"]);
		expect("LC_ALL" in env).toBe(false);
	});
});
