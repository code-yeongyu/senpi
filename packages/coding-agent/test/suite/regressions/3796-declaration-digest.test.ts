// #3796: shared machine-consumed native/legacy declaration identity fixture.
/* oxlint-disable eslint/no-template-curly-in-string -- these tests feed literal MCP config text such as "${TOKEN}" to the interpolation under test. */
import { expect, it } from "vitest";
import {
	type DeclarationIdentity,
	declarationDigest,
} from "../../../src/core/extensions/builtin/mcp/env-grants-store.ts";

const identity = {
	sourcePath: "/fixture/project/skills/a/mcp.json",
	sourceKind: "sidecar",
	projectRoot: "/fixture/project",
	serverName: "probe",
	raw: {
		type: "stdio",
		command: "tool",
		args: ["--serve"],
		cwd: "./work",
		env: { TOKEN: "${TOKEN}", NODE_OPTIONS: "--no-warnings" },
	},
	cwdBase: "/fixture/project",
} satisfies DeclarationIdentity;

it("hashes the agreed canonical identity record with SHA-256", () => {
	expect(declarationDigest(identity)).toBe("a82aa53bdc6ae462ccbe72166353100b4dbf4fc6d07dfea01d12dc9c1f8f3c63");
	expect(
		declarationDigest({
			...identity,
			raw: {
				env: { NODE_OPTIONS: "--no-warnings", TOKEN: "${TOKEN}" },
				cwd: "./work",
				args: ["--serve"],
				command: "tool",
				type: "stdio",
			},
		}),
	).toBe(declarationDigest(identity));
});

it.each([
	{ ...identity, raw: { ...identity.raw, command: "other-tool" } },
	{ ...identity, raw: { ...identity.raw, env: { ...identity.raw.env, NODE_OPTIONS: "--trace-warnings" } } },
	{ ...identity, raw: { url: "https://one.example.test/mcp" } },
	{ ...identity, sourceKind: "frontmatter" },
	{ ...identity, cwdBase: "/fixture/other-cwd" },
])("binds execution, authentication and source authority changes", (changed) => {
	expect(declarationDigest(changed)).not.toBe(declarationDigest(identity));
});
