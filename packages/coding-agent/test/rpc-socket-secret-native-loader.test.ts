import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	loadSocketSecretNative,
	SocketSecretNativeAbiMismatchError,
	SocketSecretNativeUnavailableError,
	socketSecretNativeCandidatePaths,
} from "../src/modes/rpc/socket-secret-native.ts";

const options = {
	packageDir: "/package",
	moduleDir: "/source/src/modes/rpc",
	execPath: "/bin/senpi.exe",
	platform: "win32",
	arch: "arm64",
	env: {},
};
const relative = join("native/socket-secret/prebuilds/win32-arm64", "senpi_socket_secret.win32-arm64.node");
const candidates = [
	join(options.packageDir, relative),
	join(options.moduleDir, "../../..", relative),
	join(dirname(options.execPath), relative),
];
const binding = (abi = "1") => ({
	__senpiSocketSecretAbi1: vi.fn(() => abi),
	publishNoReplace: vi.fn(),
	kernelSessionIdentity: vi.fn(),
	classifyVolume: vi.fn(),
});

describe("socket-secret bridge loader", () => {
	it("tries the package, module-relative and executable-relative prebuilds for the host", () => {
		expect(socketSecretNativeCandidatePaths(options)).toEqual(candidates);
	});

	it("treats SENPI_SOCKET_SECRET_NATIVE_PATH as the only candidate", () => {
		const env = { SENPI_SOCKET_SECRET_NATIVE_PATH: "/override.node" };
		expect(socketSecretNativeCandidatePaths({ ...options, env })).toEqual(["/override.node"]);
	});

	it("returns the first candidate that loads with the expected ABI", () => {
		const loaded = binding();
		const requireBinding = vi.fn((path: string) => {
			if (path === candidates[0]) throw new Error("not found");
			return loaded;
		});
		expect(loadSocketSecretNative({ ...options, requireBinding })).toBe(loaded);
		expect(requireBinding.mock.calls.map(([path]) => path)).toEqual(candidates.slice(0, 2));
	});

	// No optional fallback (design 4.5/4.6): a missing bridge is an error the caller must surface.
	it("throws a typed error naming every attempted path when no candidate loads", () => {
		const requireBinding = vi.fn(() => {
			throw new Error("not found");
		});
		const failure = (() => {
			try {
				loadSocketSecretNative({ ...options, requireBinding });
			} catch (error) {
				return error;
			}
		})();
		expect(failure).toBeInstanceOf(SocketSecretNativeUnavailableError);
		expect(failure).toMatchObject({ code: "socket-secret-native-unavailable", attemptedPaths: candidates });
	});

	it("stops at a binary built for another ABI instead of trying the next candidate", () => {
		const requireBinding = vi.fn(() => binding("2"));
		expect(() => loadSocketSecretNative({ ...options, requireBinding })).toThrow(SocketSecretNativeAbiMismatchError);
		expect(requireBinding).toHaveBeenCalledTimes(1);
	});

	it("rejects a binary missing one of the exports", () => {
		const { classifyVolume: _, ...partial } = binding();
		expect(() => loadSocketSecretNative({ ...options, requireBinding: () => partial })).toThrow(
			SocketSecretNativeAbiMismatchError,
		);
	});
});
