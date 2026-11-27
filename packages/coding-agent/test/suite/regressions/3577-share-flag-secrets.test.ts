import { describe, expect, it } from "vitest";
import type { ShareRedactionContext } from "../../../src/core/share/share-redaction.ts";
import { prepareShare } from "../../../src/core/share/share-session.ts";

// senpi#3577: tool-call arguments are uploaded by /share by default, and a secret passed as a command-line flag or said in
// prose had no key:value shape for the redactor to find. Values are assembled at runtime so no credential-shaped literal
// sits in the repository; they are short and low-entropy on purpose, so only the flag/prose rule can catch them.
const PASSWORD = ["hun", "ter", "2x"].join("");
const TOKEN = ["tok", "en", "77"].join("");
const HEX_40 = "0123456789abcdef".repeat(3).slice(0, 40);

const context: ShareRedactionContext = { homeDirectory: "/home/someone", userName: "someone", hostName: "box.local" };

/** The bytes /share would upload for one assistant turn that ran `command` (or passed `args`) as a tool call. */
function sharedBytes(argumentsValue: Record<string, unknown>): string {
	const session = {
		messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: argumentsValue }] }],
	};
	return prepareShare((sanitize) => JSON.stringify(sanitize(session)), context).html;
}

describe("share redacts secrets passed as flags and in prose (senpi#3577)", () => {
	it.each([
		["a long password flag", `mysql --password ${PASSWORD} db`, PASSWORD],
		["a long password flag with =", `psql --password=${PASSWORD}`, PASSWORD],
		["a token flag", `curl --token ${TOKEN} https://example.com`, TOKEN],
		["an api-key flag with a hex value", `tool --api-key ${HEX_40}`, HEX_40],
		["mysql's glued -p password", `mysql -u root -p${PASSWORD} db`, PASSWORD],
		["a password said in prose", `my password is ${PASSWORD} for the db`, PASSWORD],
	])("%s", (_name, command, secret) => {
		const bytes = sharedBytes({ command });
		expect(bytes).not.toContain(secret);
		expect(bytes).toContain("<redacted>");
	});

	it("an argument list that passes a secret after its flag", () => {
		const bytes = sharedBytes({ args: ["--api-key", HEX_40, "--verbose"] });
		expect(bytes).not.toContain(HEX_40);
		expect(bytes).toContain("--verbose");
	});

	it.each([
		["a boolean flag", "rg --verbose needle"],
		["a path flag", "tool --path src/main.ts"],
		["mkdir -p with a directory", "mkdir -p build/out"],
		["a token budget flag", "senpi --max-tokens 4096"],
		["prose about a password that names no value", "the password field is required"],
	])("leaves %s alone", (_name, command) => {
		expect(sharedBytes({ command })).toContain(command);
	});
});
