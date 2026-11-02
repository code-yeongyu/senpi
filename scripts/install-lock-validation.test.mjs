import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateGeneratedFiles } from "./install-lock-validation.mjs";

function validationOptions(packages, lockstepInternalNames, internalNames = lockstepInternalNames) {
	return {
		installerPackageJson: {
			name: "@code-yeongyu/senpi-install",
			version: "2026.8.12-4",
			dependencies: { "@code-yeongyu/senpi": "2026.8.12-4" },
		},
		installLock: {
			name: "@code-yeongyu/senpi-install",
			version: "2026.8.12-4",
			lockfileVersion: 3,
			packages: {
				"": {
					name: "@code-yeongyu/senpi-install",
					version: "2026.8.12-4",
					dependencies: { "@code-yeongyu/senpi": "2026.8.12-4" },
				},
				...packages,
				"node_modules/@vendor/platform": {
					version: "1.0.0",
					resolved: "https://registry.npmjs.org/@vendor/platform/-/platform-1.0.0.tgz",
					integrity: "sha512-test",
					os: ["darwin"],
				},
			},
		},
		internalNames,
		lockstepInternalNames,
		internalPackagePrefixes: ["@earendil-works/pi-", "@code-yeongyu/senpi"],
		allowedInstallScriptPackages: new Map(),
	};
}

describe("validateGeneratedFiles", () => {
	it("accepts lockstep telemetry as a bundled internal workspace", () => {
		assert.doesNotThrow(() =>
			validateGeneratedFiles(
				validationOptions(
					{
						"node_modules/@code-yeongyu/senpi": { version: "2026.8.12-4", inBundle: true },
						"node_modules/@earendil-works/pi-telemetry": { version: "2026.8.12-4", inBundle: true },
					},
					new Set(["@code-yeongyu/senpi", "@earendil-works/pi-telemetry"]),
				),
			),
		);
	});

	it("still rejects release-managed internal version drift", () => {
		assert.throws(
			() =>
				validateGeneratedFiles(
					validationOptions(
						{
							"node_modules/@code-yeongyu/senpi": { version: "0.84.1", inBundle: true },
						},
						new Set(["@code-yeongyu/senpi"]),
					),
				),
			/internal package version 0\.84\.1 does not match 2026\.8\.12-4/,
		);
	});

	it("requires integrity metadata for non-bundled registry packages", () => {
		assert.throws(
			() =>
				validateGeneratedFiles(
					validationOptions(
						{
							"node_modules/@code-yeongyu/senpi": { version: "2026.8.12-4", inBundle: true },
							"node_modules/example": {
								version: "1.0.0",
								resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
							},
						},
						new Set(["@code-yeongyu/senpi"]),
						new Set(["@code-yeongyu/senpi"]),
					),
				),
			/node_modules\/example is missing integrity registry metadata/,
		);
	});
});
