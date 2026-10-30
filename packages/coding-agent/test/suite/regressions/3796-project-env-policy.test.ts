// #3796: the finite base is a shared native/legacy machine-consumed fixture.
/* oxlint-disable eslint/no-template-curly-in-string -- these tests feed literal MCP config text such as "${TOKEN}" to the interpolation under test. */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	mergeProjectEnv,
	PROJECT_MCP_SAFE_BASE_NAMES,
	projectMcpEnvironment,
} from "../../../src/core/extensions/builtin/mcp/project-env.ts";

it("pins the safe base to the shared policy fixture", () => {
	const fixture = JSON.parse(readFileSync(new URL("../../fixtures/mcp-env-policy.json", import.meta.url), "utf8"));
	expect(PROJECT_MCP_SAFE_BASE_NAMES).toEqual(fixture.safeBaseNames);
});

it("withholds off-pattern names, DSNs, cookies, locale secrets and proxies", () => {
	const raw = {
		command: "synthetic",
		env: {
			A: "${ODD_SECRET}",
			B: "${SERVICE_DSN}",
			C: "${COOKIE_VALUE}",
			D: "${LC_SECRET}",
			E: "${HTTPS_PROXY}",
		},
	};
	const ambient = {
		PATH: "/synthetic/bin",
		HOME: "/synthetic/home",
		LC_TIME: "C",
		LC_SECRET: "synthetic-private",
		ODD_SECRET: "synthetic-secret",
		SERVICE_DSN: "synthetic-dsn",
		COOKIE_VALUE: "synthetic-cookie",
		HTTPS_PROXY: "http://synthetic.invalid",
	};
	const policy = projectMcpEnvironment(raw, false, [], undefined, ambient);
	expect(policy.withheld).toEqual(["COOKIE_VALUE", "HTTPS_PROXY", "LC_SECRET", "ODD_SECRET", "SERVICE_DSN"]);
	expect(policy.env).toEqual({ PATH: "/synthetic/bin", HOME: "/synthetic/home", LC_TIME: "C", ...raw.env });
	expect(JSON.stringify(policy.withheld)).not.toContain("synthetic-private");
});

it("re-resolves exactly granted references and preserves merge order", () => {
	const raw = { command: "synthetic", env: { REF: "${ODD_DSN}", OTHER: "${ODD_COOKIE}", HOME: "declared" } };
	const policy = projectMcpEnvironment(
		raw,
		false,
		["ODD_DSN"],
		{ HOME: "explicit", SESSION: "caller" },
		{ HOME: "ambient", ODD_DSN: "synthetic-dsn", ODD_COOKIE: "synthetic-cookie" },
	);
	expect(policy.env).toEqual({
		HOME: "declared",
		ODD_DSN: "synthetic-dsn",
		SESSION: "caller",
		REF: "synthetic-dsn",
		OTHER: "${ODD_COOKIE}",
	});
	expect(policy.withheld).toEqual(["ODD_COOKIE"]);
	expect(raw.env.REF).toBe("${ODD_DSN}");
});

it("restores a granted bearer variable and only granted remote references", () => {
	const raw = {
		url: "https://synthetic.invalid/${PATH_PART}",
		headers: { "X-Token": "${HEADER_TOKEN}" },
		auth: "bearer" as const,
		bearerTokenEnv: "BEARER_TOKEN",
	};
	const ambient = { PATH_PART: "part", HEADER_TOKEN: "synthetic-header", BEARER_TOKEN: "synthetic-bearer" };
	const withheld = projectMcpEnvironment(raw, true, [], undefined, ambient);
	expect(withheld.declaration.auth).toBe(false);
	expect(withheld.declaration.bearerTokenEnv).toBeUndefined();
	const granted = projectMcpEnvironment(raw, true, ["BEARER_TOKEN", "HEADER_TOKEN"], undefined, ambient);
	expect(granted.declaration.auth).toBe("bearer");
	expect(granted.declaration.bearerTokenEnv).toBe("BEARER_TOKEN");
	expect(granted.declaration.headers).toEqual({ "X-Token": "synthetic-header" });
	expect(granted.declaration.url).toBe(raw.url);
	expect(granted.withheld).toEqual(["PATH_PART"]);
});

it("keeps trusted stdio expansion and command-substitution refusal", () => {
	expect(
		projectMcpEnvironment(
			{ command: "synthetic", env: { REF: "${VALUE}" } },
			true,
			[],
			{ VALUE: "caller" },
			{ VALUE: "ambient" },
		).env.REF,
	).toBe("caller");
	expect(() => projectMcpEnvironment({ command: "$(synthetic)" }, true, [])).toThrow("command substitution");
});

it("replaces every Windows key variant with the later declared key", () => {
	expect(
		mergeProjectEnv([{ Path: "mixed", PATH: "upper" }, { path: "explicit" }, { Path: "declared" }], true),
	).toEqual({ Path: "declared" });
});
