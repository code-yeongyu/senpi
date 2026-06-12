import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREDENTIAL_ENV_VARS } from "../../ai/src/env-api-keys.ts";
import { collectInjectedCredentialKeys } from "../src/bun/strip-project-dotenv.ts";

describe("collectInjectedCredentialKeys", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "senpi-dotenv-strip-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("reports provider credentials injected from project dotenv files", () => {
		writeFileSync(join(tempDir, ".env"), "ANTHROPIC_API_KEY=evil\n");

		const keys = collectInjectedCredentialKeys(tempDir, { ANTHROPIC_API_KEY: "evil" }, CREDENTIAL_ENV_VARS);

		expect(keys).toEqual(["ANTHROPIC_API_KEY"]);
	});

	it("keeps a shell-provided credential when it differs from project dotenv", () => {
		writeFileSync(join(tempDir, ".env"), "ANTHROPIC_API_KEY=evil\n");

		const keys = collectInjectedCredentialKeys(tempDir, { ANTHROPIC_API_KEY: "real" }, CREDENTIAL_ENV_VARS);

		expect(keys).toEqual([]);
	});

	it("reports raw expansion values as unsafe even when the resolved env differs", () => {
		writeFileSync(join(tempDir, ".env"), `ANTHROPIC_API_KEY=$${"{UNSET:-evil}"}\n`);

		const keys = collectInjectedCredentialKeys(tempDir, { ANTHROPIC_API_KEY: "anything" }, CREDENTIAL_ENV_VARS);

		expect(keys).toEqual(["ANTHROPIC_API_KEY"]);
	});

	it("normalizes export prefixes, quotes, comments, and CRLF before comparing", () => {
		writeFileSync(
			join(tempDir, ".env"),
			[
				'export ANTHROPIC_API_KEY="evil" # comment\r',
				"OPENAI_API_KEY='quoted'\r",
				"AWS_PROFILE=work # comment\r",
			].join("\n"),
		);

		const keys = collectInjectedCredentialKeys(
			tempDir,
			{
				ANTHROPIC_API_KEY: "evil",
				OPENAI_API_KEY: "quoted",
				AWS_PROFILE: "work",
			},
			CREDENTIAL_ENV_VARS,
		);

		expect(keys).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_PROFILE"]);
	});

	it("ignores non-credential dotenv variables", () => {
		writeFileSync(join(tempDir, ".env"), "MY_APP_PORT=3000\n");

		const keys = collectInjectedCredentialKeys(tempDir, { MY_APP_PORT: "3000" }, CREDENTIAL_ENV_VARS);

		expect(keys).toEqual([]);
	});

	it("consults supported dotenv variants including NODE_ENV variants", () => {
		writeFileSync(join(tempDir, ".env.local"), "ANTHROPIC_API_KEY=local\n");
		writeFileSync(join(tempDir, ".env.development"), "OPENAI_API_KEY=dev\n");
		writeFileSync(join(tempDir, ".env.development.local"), "AWS_PROFILE=devlocal\n");
		writeFileSync(join(tempDir, ".env.test"), "GOOGLE_APPLICATION_CREDENTIALS=/tmp/adc.json\n");
		writeFileSync(join(tempDir, ".env.test.local"), "GOOGLE_CLOUD_PROJECT=test-project\n");

		const keys = collectInjectedCredentialKeys(
			tempDir,
			{
				ANTHROPIC_API_KEY: "local",
				OPENAI_API_KEY: "dev",
				AWS_PROFILE: "devlocal",
				GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
				GOOGLE_CLOUD_PROJECT: "test-project",
				NODE_ENV: "test",
			},
			CREDENTIAL_ENV_VARS,
		);

		expect(keys).toEqual([
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
			"AWS_PROFILE",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"GOOGLE_CLOUD_PROJECT",
		]);
	});
});
