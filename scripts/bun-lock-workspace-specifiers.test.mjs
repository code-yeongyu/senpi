import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	findSpecifierMismatches,
	parseBunLock,
	repairWorkspaceSpecifiers,
	targetsLocalWorkspace,
	workspaceKey,
} from "./bun-lock-workspace-specifiers.mjs";

// senpi#2352: the shape Bun 1.4.2 left behind after release v2026.9.29. Workspace versions are
// bumped, but the ranges they declare on each other still name the previous releases.
const STALE_LOCK = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "senpi-monorepo",
      "devDependencies": {
        "typebox": "1.3.34",
      },
    },
    "packages/agent": {
      "name": "@earendil-works/pi-agent-core",
      "version": "2026.9.29",
      "dependencies": {
        "@earendil-works/pi-ai": "^2026.9.28-7",
        "typebox": "1.3.34",
      },
    },
    "packages/ai": {
      "name": "@earendil-works/pi-ai",
      "version": "2026.9.29",
    },
    "packages/server": {
      "name": "@code-yeongyu/senpi-server",
      "version": "2026.9.29",
      "dependencies": {
        "@earendil-works/pi-agent-core": "^2026.9.28-3",
        "@earendil-works/pi-ai": "^2026.9.28-3",
      },
    },
  },
  "packages": {
    "@earendil-works/pi-ai": ["@earendil-works/pi-ai@workspace:packages/ai"],
    "typebox": ["typebox@1.3.34", "", {}, "sha512-x,}"],
  }
}
`;

function manifests(overrides = {}) {
	return new Map([
		["package.json", { name: "senpi-monorepo", devDependencies: { typebox: "1.3.34" } }],
		[
			"packages/agent/package.json",
			{
				name: "@earendil-works/pi-agent-core",
				version: "2026.9.29",
				dependencies: { "@earendil-works/pi-ai": "^2026.9.29", typebox: "1.3.34", ...overrides.agent },
			},
		],
		["packages/ai/package.json", { name: "@earendil-works/pi-ai", version: "2026.9.29" }],
		[
			"packages/server/package.json",
			{
				name: "@code-yeongyu/senpi-server",
				version: "2026.9.29",
				dependencies: { "@earendil-works/pi-agent-core": "^2026.9.29", "@earendil-works/pi-ai": "^2026.9.29" },
			},
		],
	]);
}

describe("parseBunLock", () => {
	it("parses bun.lock's trailing commas without touching commas inside strings", () => {
		const lock = parseBunLock(STALE_LOCK);

		assert.equal(lock.workspaces["packages/agent"].dependencies.typebox, "1.3.34");
		assert.equal(lock.packages.typebox[3], "sha512-x,}");
	});
});

describe("workspaceKey", () => {
	it("maps the root manifest to the empty key and workspace manifests to their directory", () => {
		assert.equal(workspaceKey("package.json"), "");
		assert.equal(workspaceKey("packages/session-backends/sqlite-node/package.json"), "packages/session-backends/sqlite-node");
	});
});

describe("targetsLocalWorkspace", () => {
	it("accepts only specifiers that resolve to the local workspace version", () => {
		assert.equal(targetsLocalWorkspace("^2026.9.29", "2026.9.29"), true);
		assert.equal(targetsLocalWorkspace("2026.9.29", "2026.9.29"), true);
		assert.equal(targetsLocalWorkspace("workspace:*", "2026.9.29"), true);
		assert.equal(targetsLocalWorkspace("^0.84.4", "2026.9.29"), false);
	});
});

describe("findSpecifierMismatches (senpi#2352)", () => {
	it("reports every workspace range bun.lock records differently from its manifest", () => {
		const mismatches = findSpecifierMismatches(parseBunLock(STALE_LOCK), manifests());

		assert.deepEqual(
			mismatches.map(({ workspace, name, recorded, declared }) => [workspace, name, recorded, declared]),
			[
				["packages/agent", "@earendil-works/pi-ai", "^2026.9.28-7", "^2026.9.29"],
				["packages/server", "@earendil-works/pi-agent-core", "^2026.9.28-3", "^2026.9.29"],
				["packages/server", "@earendil-works/pi-ai", "^2026.9.28-3", "^2026.9.29"],
			],
		);
	});

	it("reports dependencies present on only one side", () => {
		const mismatches = findSpecifierMismatches(parseBunLock(STALE_LOCK), manifests({ agent: { chalk: "5.6.2" } }));

		assert.ok(mismatches.some((m) => m.name === "chalk" && m.recorded === undefined && m.declared === "5.6.2"));
	});
});

describe("repairWorkspaceSpecifiers (senpi#2352)", () => {
	it("rewrites stale local-workspace ranges in place and leaves the rest of the text byte-identical", () => {
		const { text, repaired } = repairWorkspaceSpecifiers(STALE_LOCK, manifests());

		assert.equal(repaired.length, 3);
		assert.deepEqual(findSpecifierMismatches(parseBunLock(text), manifests()), []);
		assert.equal(text, STALE_LOCK.replace('"^2026.9.28-7"', '"^2026.9.29"').replaceAll('"^2026.9.28-3"', '"^2026.9.29"'));
	});

	it("leaves external and registry-resolved specifiers for Bun to re-resolve", () => {
		const { repaired } = repairWorkspaceSpecifiers(STALE_LOCK, manifests({ agent: { typebox: "1.3.35" } }));

		assert.equal(
			repaired.some((m) => m.name === "typebox"),
			false,
		);
	});
});
