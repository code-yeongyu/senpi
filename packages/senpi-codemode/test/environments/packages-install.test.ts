import { describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { runPackagesInstall } from "../../src/environments/packages-install.ts";
import type { InstallReceipt } from "../../src/environments/py-environment.ts";
import { EnvironmentError, normalizePipInstall } from "../../src/environments/py-installer.ts";
import { PythonEnvironments } from "../../src/environments/python-environments.ts";

function python(install: PythonEnvironments["install"]): PythonEnvironments {
	const environments = new PythonEnvironments({
		artifactsDir: "/nonexistent/artifacts",
		cwd: "/nonexistent",
		interpreter: "python3",
		settings: defaultCodemodeSettings,
	});
	environments.install = install;
	return environments;
}

const receipt: InstallReceipt = {
	manager: "pip",
	mode: "managed",
	root: "/nonexistent/rev-1",
	revision: 1,
	requested: ["probe"],
	resolved: ["probe-1.0"],
	changed: true,
};

// An installer that runs until its signal aborts, then reports a cancellation the way pip's runner does.
const untilAborted: PythonEnvironments["install"] = (_requirements, signal) =>
	new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () =>
			reject(new EnvironmentError("environment_install_cancelled", "the install was cancelled; pip was stopped")),
		);
	});

describe("packages.install() host dispatch", () => {
	it("passes the requirement list to the session installer as separate arguments, never re-split, and returns its receipt", async () => {
		let seen: string | readonly string[] = "";
		const environments = python(async (requirements) => {
			seen = requirements;
			return receipt;
		});
		const requirements = ["--no-index", "/tmp/a wheel.whl", 'requests; python_version >= "3.8"', "/tmp/a\\$b.whl"];

		const result = await runPackagesInstall({ manager: "pip", requirements }, { python: environments }, undefined);

		expect(result).toBe(receipt);
		expect(seen).toEqual(requirements);
	});

	it("validates a list with the same %pip rules, keeping markers and backslashes as written", () => {
		expect(
			normalizePipInstall(["install", "--no-index", 'requests; python_version >= "3.8"', "/tmp/a\\$b.whl"]),
		).toEqual(["--no-index", 'requests; python_version >= "3.8"', "/tmp/a\\$b.whl"]);
		expect(() => normalizePipInstall(["install", "--target=/elsewhere", "probe"])).toThrow(/--target is not allowed/);
	});

	it("fails with environment_install_timeout when the install outlives its timeout", async () => {
		const pending = runPackagesInstall(
			{ manager: "pip", requirements: "probe", timeout: 0.05 },
			{ python: python(untilAborted) },
			undefined,
		);

		await expect(pending).rejects.toThrow(/^environment_install_timeout: the install did not finish within 0\.05s/);
	});

	it("reports the owning cell's stop as environment_install_cancelled, not as a timeout", async () => {
		const controller = new AbortController();
		const pending = runPackagesInstall(
			{ manager: "pip", requirements: "probe", timeout: 60 },
			{ python: python(untilAborted) },
			controller.signal,
		);
		controller.abort();

		await expect(pending).rejects.toThrow(/^environment_install_cancelled:/);
	});

	it("refuses a manager whose environment the cell does not have", async () => {
		await expect(runPackagesInstall({ manager: "bun", requirements: "probe" }, {}, undefined)).rejects.toThrow(
			/^environment_installer_unavailable: bun\/npm installs run only in a JavaScript cell/,
		);
		await expect(runPackagesInstall({ manager: "pip", requirements: "probe" }, {}, undefined)).rejects.toThrow(
			/^environment_installer_unavailable: pip installs need this session to have a Python interpreter/,
		);
	});

	it("refuses malformed arguments before any install starts", async () => {
		const environments = { python: python(untilAborted) };
		for (const args of [
			{ manager: "cargo", requirements: "probe" },
			{ manager: "pip", requirements: [] },
			{ manager: "pip", requirements: [""] },
			{ manager: "pip", requirements: "probe", timeout: 0 },
		]) {
			await expect(runPackagesInstall(args, environments, undefined)).rejects.toThrow(
				/^environment_install_failed: packages\.install\(\): /,
			);
		}
	});
});
