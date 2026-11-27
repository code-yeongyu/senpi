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
		["a long password flag", `deploy --password ${PASSWORD} prod`, PASSWORD],
		["mysql's --password= value", `mysql -u root --password=${PASSWORD} db`, PASSWORD],
		["a long password flag with =", `psql --password=${PASSWORD}`, PASSWORD],
		["a token flag", `curl --token ${TOKEN} https://example.com`, TOKEN],
		["an api-key flag with a hex value", `tool --api-key ${HEX_40}`, HEX_40],
		["mysql's glued -p password", `mysql -u root -p${PASSWORD} db`, PASSWORD],
		["a password said in prose", `my password is ${PASSWORD} for the db`, PASSWORD],
		// Review of #7552 (7214813462): quoted and continued values, letters-only and quoted prose, and the common clients.
		["mysql's quoted -p password", `mysql -u root -p'${PASSWORD}' db`, PASSWORD],
		["mysql's double-quoted -p password", `mysql -u root -p"${PASSWORD}" db`, PASSWORD],
		["a flag value continued on the next line", `tool --password \\\n  ${PASSWORD}`, PASSWORD],
		["a quoted multi-word password in prose", "the password is 'correct horse' ok", "correct horse"],
		["a token said in prose", `the token is ${TOKEN} now`, TOKEN],
		["curl -u user:password", `curl -u alice:${PASSWORD} https://example.com`, PASSWORD],
		["curl --user user:password", `curl --user alice:${PASSWORD} https://example.com`, PASSWORD],
		["sshpass -p", `sshpass -p ${PASSWORD} ssh host`, PASSWORD],
		["redis-cli -a", `redis-cli -a ${PASSWORD} ping`, PASSWORD],
		["PGPASSWORD in the environment", `PGPASSWORD=${PASSWORD} psql -h db`, PASSWORD],
		// Second review of #7552 (7215496541): continuations, quoted curl credentials, glued and `=` forms.
		["mysql -p across line continuations", `mysql \\\n  -u root \\\n  -p${PASSWORD} db`, PASSWORD],
		["mysql quoted -p after a continuation", `mysql -u root \\\n -p'${PASSWORD} x' db`, PASSWORD],
		["sshpass -p across a continuation", `sshpass -p \\\n ${PASSWORD} ssh host`, PASSWORD],
		["curl -u after a continuation", `curl \\\n -u alice:${PASSWORD} https://x`, PASSWORD],
		["curl -u quoted with a space in the password", `curl -u 'alice:${PASSWORD} x y' https://x`, `${PASSWORD} x y`],
		["curl --user=user:password", `curl --user=alice:${PASSWORD} https://x`, PASSWORD],
		["curl -u glued", `curl -ualice:${PASSWORD} https://x`, PASSWORD],
		["sshpass -p glued", `sshpass -p${PASSWORD} ssh host`, PASSWORD],
		// Third review of #7552 (7216126614).
		["curl with clustered short flags", `curl -su alice:${PASSWORD} https://x`, PASSWORD],
		["curl with a longer cluster", `curl -sSu alice:${PASSWORD} https://x`, PASSWORD],
		["a continuation right after =", `tool --password=\\\n${PASSWORD}`, PASSWORD],
		["a double continuation", `tool --password \\\n \\\n ${PASSWORD}`, PASSWORD],
		["docker login -p", `docker login -u bob -p ${PASSWORD} registry.example.com`, PASSWORD],
		// Fourth review of #7552 (7218785669).
		["mysql's glued -p split by a continuation", `mysql -u root -p\\\n${PASSWORD} db`, PASSWORD],
		["a password stated after 'is:'", `my password is: ${PASSWORD} for the db`, PASSWORD],
		["a password stated after 'is:' with no space", `my password is:${PASSWORD}`, PASSWORD],
		// Fifth review of #7552 (Opus at 795676dcb5, M1): a client name that is not the command's program grants no exception.
		["a script whose name contains mysql", `./scripts/backup-mysql.sh --password ${PASSWORD}`, PASSWORD],
		["a host named mysql", `migrate --db-host mysql.internal --password ${PASSWORD}`, PASSWORD],
		["a driver named psql", `deploy --driver psql --password ${PASSWORD}`, PASSWORD],
		["a later command after psql", `psql -c x; deploy --password ${PASSWORD}`, PASSWORD],
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
		["a later command after a mysql call", "mysql -u r db && tar -pxf a.tar"],
		[
			"a boolean password flag followed by a placeholder-free argument",
			"docker login --password-stdin registry.example.com",
		],
		["a password length in prose", "the password is 12 characters long"],
		["a short ordinary word after 'token is'", "git commit -m 'token is ready'"],
		["an idiom about a secret", "the secret is out"],
		["ssh's port flag", "ssh -p 2222 host"],
		["docker's port mapping", "docker run -p 8080:80 nginx"],
		["curl -u with a user and no password", "curl -u alice https://example.com"],
		["the command sshpass runs keeps its own -p (env password)", "sshpass -e ssh -p 2222 host"],
		["the command sshpass runs keeps its own -p (file password)", "sshpass -f pwfile ssh -p 2222 host"],
		["curl's --user-agent", "curl --user-agent=Foo:bar https://x"],
		["psql's prompting --password keeps the database", "psql --password mydb"],
		["mysql's prompting --password keeps the database", "mysql -u root --password mydb"],
		["a prompting --password after env assignments and sudo", "PGHOST=db sudo psql --password mydb"],
		["a prompting --password with a path to the client", "/usr/bin/psql --password mydb"],
		// Fifth review of #7552 (L1): boolean flags whose names read as sensitive take no value.
		["pg_dump --no-password", "pg_dump --no-password mydb"],
		["ansible --ask-pass", "ansible-playbook --ask-pass site.yml"],
		["ansible --ask-vault-pass", "ansible-playbook --ask-vault-pass site.yml"],
		["a --skip-password flag", "tool --skip-password run"],
		// A letters-only word after "password is" cannot be told from prose, so it stays (accepted, documented).
		["a letters-only word after 'password is'", "my password is swordfish please"],
		["a sentence about what a secret is", "the secret is that we cache"],
		["a sentence about how a token is made", "the token is generated by the server"],
		["a hyphenated word after 'token is'", "this token is per-request"],
		["a hyphenated word after 'access token is'", "The access token is short-lived"],
		["a past-tense sentence about a token", "the token was consumed"],
	])("leaves %s alone", (_name, command) => {
		expect(sharedBytes({ command })).toContain(command);
	});
});

describe("share flag redaction is idempotent and counts each secret once (senpi#7552 review)", () => {
	it("one quoted flag secret counts once, and a second pass changes and counts nothing", () => {
		const first = prepareShare(
			(sanitize) => JSON.stringify(sanitize({ command: 'tool --secret="abc def ghi"' })),
			context,
		);
		expect(first.tally.get("credential")).toBe(1);
		const again = prepareShare((sanitize) => sanitize(first.html), context);
		expect(again.html).toBe(first.html);
		expect(again.tally.get("credential") ?? 0).toBe(0);
	});
});

describe("a secret already redacted ahead of a later short flag (senpi#7552 review)", () => {
	it("keeps ssh's port and counts the one secret once", () => {
		const token = `${"ghp"}_${"a".repeat(36)}`;
		const first = prepareShare(
			(sanitize) => JSON.stringify(sanitize({ command: `sshpass -p ${token} ssh -p 2222 host` })),
			context,
		);
		expect(first.html).toContain("ssh -p 2222 host");
		expect(first.tally.get("credential")).toBe(1);
		const again = prepareShare((sanitize) => sanitize(first.html), context);
		expect(again.html).toBe(first.html);
	});
});

describe("argument lists that pass a client's password (senpi#7552 review)", () => {
	it.each([
		["mysql's glued -p", ["mysql", "-u", "root", `-p${PASSWORD}`, "db"]],
		["sshpass -p and its value", ["sshpass", "-p", PASSWORD, "ssh", "host"]],
		["redis-cli -a", ["redis-cli", "-a", PASSWORD, "ping"]],
		["docker login -p", ["docker", "login", "-u", "bob", "-p", PASSWORD, "registry.example.com"]],
		["curl -u user:password", ["curl", "-u", `alice:${PASSWORD}`, "https://x"]],
	])("%s", (_name, args) => {
		expect(sharedBytes({ args })).not.toContain(PASSWORD);
	});

	it("a client name that is not the program grants no exception in an argument list", () => {
		expect(sharedBytes({ args: ["migrate", "--host", "mysql", "--password", PASSWORD] })).not.toContain(PASSWORD);
	});

	it("a boolean sensitive-looking flag keeps the next argument in an argument list", () => {
		expect(sharedBytes({ args: ["pg_dump", "--no-password", "mydb"] })).toContain('"mydb"');
		expect(sharedBytes({ args: ["ansible-playbook", "--ask-vault-pass", "site.yml"] })).toContain('"site.yml"');
	});

	it("psql's prompting --password keeps the database in an argument list", () => {
		expect(sharedBytes({ args: ["psql", "--password", "mydb"] })).toContain('"mydb"');
	});

	it("the command sshpass runs keeps its own -p", () => {
		expect(sharedBytes({ args: ["sshpass", "-e", "ssh", "-p", "2222", "host"] })).toContain('"2222"');
	});
});
