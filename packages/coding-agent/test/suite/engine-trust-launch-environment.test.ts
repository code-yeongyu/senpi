/**
 * Security contract (omo#10762, design r13 5.2 and 5.4): the one builder every trust writer uses,
 * the arrival classification a launch decides from, and the post-adoption restore. A writer that
 * leaves a second case form of a trust name on Windows lets the child's CRT pick which file Bun
 * loads; a restore that leaves the marker or the hop in JS `process.env` makes a nested `omo` exit 78.
 */
import { describe, expect, it } from "vitest";
import {
	applyEngineTrustRestore,
	buildTrustLaunchEnvironment,
	classifyTrustArrival,
	EngineTrustContractError,
	parseEngineTrustMarker,
	serializeEngineTrustMarker,
} from "../../src/engine-trust/index.ts";
import { serverMarker, standaloneMarker } from "./engine-trust-fixtures.ts";

type Env = Record<string, string | undefined>;

function namesLike(env: Env, name: string): string[] {
	return Object.keys(env).filter((key) => key.toUpperCase() === name);
}

describe("classifyTrustArrival", () => {
	const marker = serializeEngineTrustMarker(serverMarker);

	it("reads an addressed marker, a foreign one and none", () => {
		expect(classifyTrustArrival({}, "linux")).toEqual({ hop: false, marker: { kind: "none" } });
		expect(
			classifyTrustArrival({ SENPI_ENGINE_TRUST: marker, NODE_EXTRA_CA_CERTS: serverMarker.file }, "linux"),
		).toEqual({ hop: false, marker: { kind: "addressed", marker: serverMarker } });
		expect(
			classifyTrustArrival({ SENPI_ENGINE_TRUST: marker, NODE_EXTRA_CA_CERTS: "/other.pem" }, "linux").marker,
		).toEqual({ kind: "foreign", reason: "file-mismatch" });
		expect(classifyTrustArrival({ SENPI_ENGINE_TRUST: marker }, "linux").marker).toEqual({
			kind: "foreign",
			reason: "file-mismatch",
		});
		expect(
			classifyTrustArrival({ SENPI_ENGINE_TRUST: "{", NODE_EXTRA_CA_CERTS: serverMarker.file }, "linux").marker,
		).toEqual({ kind: "foreign", reason: "unparseable" });
	});

	it("counts the hop when the name exists with any value, in any case form only on Windows", () => {
		expect(classifyTrustArrival({ SENPI_ENGINE_TRUST_HOP: "" }, "darwin").hop).toBe(true);
		expect(classifyTrustArrival({ senpi_engine_trust_hop: "1" }, "darwin").hop).toBe(false);
		expect(classifyTrustArrival({ senpi_engine_trust_hop: "1" }, "win32").hop).toBe(true);
	});

	it("reads Windows case forms the way the CRT does, and never guesses between two values", () => {
		const lower = { Senpi_Engine_Trust: marker, node_extra_ca_certs: serverMarker.file };
		expect(classifyTrustArrival(lower, "win32").marker.kind).toBe("addressed");
		expect(classifyTrustArrival(lower, "linux").marker.kind).toBe("none");
		const twoFiles = { ...lower, NODE_EXTRA_CA_CERTS: "/other.pem" };
		expect(classifyTrustArrival(twoFiles, "win32").marker).toEqual({ kind: "foreign", reason: "ambiguous" });
		const otherMarker = serializeEngineTrustMarker({ ...serverMarker, sha256: "c".repeat(64) });
		const twoMarkers = { ...lower, SENPI_ENGINE_TRUST: otherMarker };
		expect(classifyTrustArrival(twoMarkers, "win32").marker).toEqual({ kind: "foreign", reason: "ambiguous" });
	});
});

describe("buildTrustLaunchEnvironment", () => {
	const windowsArrival: Env = {
		Path: "C:\\Windows",
		node_extra_ca_certs: "C:\\user.pem",
		Senpi_Engine_Trust: "{}",
		senpi_engine_trust_hop: "1",
		node_use_system_ca: "1",
		Bun_Options: "--use-system-ca",
		ssl_cert_file: "C:\\ambient.pem",
		SSL_CERT_DIR: "C:\\ambient",
	};

	it("leaves exactly one canonical entry per name it writes and none for a name it does not (Windows)", () => {
		const env = buildTrustLaunchEnvironment(windowsArrival, { marker: serverMarker, hop: false, platform: "win32" });
		for (const name of ["NODE_EXTRA_CA_CERTS", "SENPI_ENGINE_TRUST", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
			expect(namesLike(env, name), name).toEqual([name]);
		}
		for (const name of ["SENPI_ENGINE_TRUST_HOP", "NODE_USE_SYSTEM_CA", "BUN_OPTIONS"]) {
			expect(namesLike(env, name), name).toEqual([]);
		}
		expect(env.Path).toBe("C:\\Windows");
		expect(env.SSL_CERT_FILE).toBe(serverMarker.defaults?.file);
		expect(env.SSL_CERT_DIR).toBe(serverMarker.defaults?.dir);
	});

	it("writes an environment the next launch reads as addressed, with the hop only when asked", () => {
		for (const hop of [false, true]) {
			const env = buildTrustLaunchEnvironment(windowsArrival, { marker: serverMarker, hop, platform: "win32" });
			expect(classifyTrustArrival(env, "win32")).toEqual({
				hop,
				marker: { kind: "addressed", marker: serverMarker },
			});
			expect(parseEngineTrustMarker(env.SENPI_ENGINE_TRUST ?? "")).toEqual(serverMarker);
		}
	});

	it("keeps a standalone user's system flag, and the user's own SSL values under an explicit opt-in", () => {
		const optIn = { ...standaloneMarker, defaults: null };
		const env = buildTrustLaunchEnvironment(
			{ NODE_USE_SYSTEM_CA: "1", BUN_OPTIONS: "--smol", SSL_CERT_FILE: "/mine.pem" },
			{ marker: optIn, hop: false, platform: "linux" },
		);
		expect(env).toMatchObject({ NODE_USE_SYSTEM_CA: "1", BUN_OPTIONS: "--smol", SSL_CERT_FILE: "/mine.pem" });
		expect(env.SSL_CERT_DIR).toBeUndefined();
	});

	it("touches only the exact names on POSIX, where case forms are different variables", () => {
		const env = buildTrustLaunchEnvironment(
			{ node_extra_ca_certs: "/lower.pem", NODE_EXTRA_CA_CERTS: "/user.pem", NODE_USE_SYSTEM_CA: "1" },
			{ marker: serverMarker, hop: false, platform: "darwin" },
		);
		expect(env.node_extra_ca_certs).toBe("/lower.pem");
		expect(env.NODE_EXTRA_CA_CERTS).toBe(serverMarker.file);
		expect(env.NODE_USE_SYSTEM_CA).toBeUndefined();
	});

	it("refuses a closure path that the hash-directory list would split", () => {
		const split = (dir: string) => ({ ...serverMarker, defaults: { file: "/e.pem", dir } });
		const build = (dir: string, platform: NodeJS.Platform) => () =>
			buildTrustLaunchEnvironment({}, { marker: split(dir), hop: false, platform });
		expect(build("/a:b", "linux")).toThrow(EngineTrustContractError);
		expect(build("C:\\a;b", "win32")).toThrow(EngineTrustContractError);
		expect(build("C:\\a", "win32")).not.toThrow();
		try {
			build("/a:b", "linux")();
		} catch (error) {
			expect(error instanceof EngineTrustContractError && error.code).toBe("trust-path-unrepresentable");
		}
	});
});

describe("applyEngineTrustRestore", () => {
	it("restores the recorded values, deletes the rest of the four, and removes the marker and the hop", () => {
		const env: Env = {
			PATH: "/bin",
			NODE_EXTRA_CA_CERTS: serverMarker.file,
			NODE_USE_SYSTEM_CA: "ambient",
			SSL_CERT_FILE: "/closure.pem",
			SSL_CERT_DIR: "/closure.d",
			BUN_OPTIONS: "kept",
			SENPI_ENGINE_TRUST: "{}",
			SENPI_ENGINE_TRUST_HOP: "1",
		};
		applyEngineTrustRestore(env, { NODE_EXTRA_CA_CERTS: "/user.pem", SSL_CERT_FILE: null }, "linux");
		expect(env).toEqual({ PATH: "/bin", NODE_EXTRA_CA_CERTS: "/user.pem", BUN_OPTIONS: "kept" });
	});

	it("reads a restore entry by value, so an undefined BUN_OPTIONS leaves the ambient one alone (senpi#4526 review)", () => {
		const env: Env = { BUN_OPTIONS: "ambient" };
		applyEngineTrustRestore(env, { BUN_OPTIONS: undefined }, "linux");
		expect(env).toEqual({ BUN_OPTIONS: "ambient" });
		const handBuilt = { ...standaloneMarker, restore: { BUN_OPTIONS: undefined } };
		expect(parseEngineTrustMarker(serializeEngineTrustMarker(handBuilt))).toEqual({
			...standaloneMarker,
			restore: {},
		});
	});

	it("restores BUN_OPTIONS only when the restore names it, and removes Windows case forms", () => {
		const env: Env = {
			node_extra_ca_certs: "x",
			Ssl_Cert_Dir: "x",
			bun_options: "ambient",
			senpi_engine_trust: "{}",
			Senpi_Engine_Trust_Hop: "1",
		};
		applyEngineTrustRestore(env, { BUN_OPTIONS: "--smol", NODE_USE_SYSTEM_CA: "1" }, "win32");
		expect(env).toEqual({ BUN_OPTIONS: "--smol", NODE_USE_SYSTEM_CA: "1" });
	});
});
