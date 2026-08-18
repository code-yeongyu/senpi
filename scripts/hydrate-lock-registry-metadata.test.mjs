import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hydrateLockRegistryMetadata } from "./hydrate-lock-registry-metadata.mjs";

describe("hydrateLockRegistryMetadata", () => {
	it("hydrates each exact package version once", async () => {
		const requests = [];
		const lockfile = {
			packages: {
				"node_modules/example": { version: "1.2.3" },
				"packages/app/node_modules/example": { version: "1.2.3" },
				"node_modules/complete": {
					version: "2.0.0",
					resolved: "https://registry.npmjs.org/complete/-/complete-2.0.0.tgz",
					integrity: "sha512-complete",
				},
				"node_modules/alias": { name: "real-package", version: "3.0.0" },
			},
		};

		await hydrateLockRegistryMetadata(lockfile, {
			fetchPackage: async (name, version) => {
				requests.push(`${name}@${version}`);
				return {
					dist: {
						tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
						integrity: `sha512-${version}`,
					},
				};
			},
		});

		assert.deepEqual(requests, ["example@1.2.3", "real-package@3.0.0"]);
		assert.equal(lockfile.packages["node_modules/example"].integrity, "sha512-1.2.3");
		assert.equal(lockfile.packages["packages/app/node_modules/example"].integrity, "sha512-1.2.3");
		assert.equal(lockfile.packages["node_modules/complete"].integrity, "sha512-complete");
		assert.equal(lockfile.packages["node_modules/alias"].integrity, "sha512-3.0.0");
	});
});
