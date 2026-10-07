import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { compiledLoaderProbeSource, extensionSource } from "./compiled-extension-fixtures.ts";
import { compiledExtensionPlatform } from "./compiled-extension-platform.ts";
import { renameSyncRetry } from "./rename-sync-retry.mjs";

const repo = resolve(import.meta.dir, "..");
// Git Bash needs an --out path relative to the checkout on Windows, where
// the system temp directory may live on a different drive.
const scratch = mkdtempSync(join(process.platform === "win32" ? repo : tmpdir(), "senpi-compiled-extension-"));
const fixturePlatform = compiledExtensionPlatform(process.platform, process.arch);
const platform = fixturePlatform.target;
const release = join(scratch, "release");
const relocated = join(scratch, `relocated${fixturePlatform.pathSuffix}binary`);
const binary = join(relocated, fixturePlatform.executable);
const probeEntry = join(repo, "scripts", `.extension-probe-${scratch.split("-").at(-1)}.ts`);
const probeBinary = join(relocated, process.platform === "win32" ? "loader-probe.exe" : "loader-probe");
const metafile = join(scratch, "metafile.json");
const responseSchema = z.object({
	type: z.string(), id: z.string().optional(), success: z.boolean().optional(), data: z.unknown().optional(), error: z.unknown().optional(),
});
const probeSchema = z.object({
	sentinel: z.literal("native-extension"), value: z.number(), dynamicIdentity: z.boolean(),
	typeboxKind: z.string(), tuiText: z.string(), url: z.string(), path: z.string(),
});
const optimizationFlags = ["--splitting", "--minify", "--keep-names"];
const releaseEntries = [
	"./dist/bun/cli.js", "./src/modes/rpc/session-worker.ts", "./src/utils/image-resize-worker.ts",
];

function extensionFixture(): string {
	const directory = mkdtempSync(join(scratch, `fixture${fixturePlatform.pathSuffix}`));
	writeFileSync(join(directory, "extension.ts"), extensionSource);
	writeFileSync(join(directory, "helper.ts"), "export const value: number = 41; export const token = {};\n");
	return join(directory, "extension.ts");
}

beforeAll(() => {
	// Given: a release-built binary, moved away from its original release location.
	const build = spawnSync("bash", ["scripts/build-binaries.sh", "--skip-install", "--skip-build", "--platform", platform, "--out", process.platform === "win32" ? relative(repo, release).replaceAll("\\", "/") : release], {
		cwd: repo, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
	});
	if (build.error) throw build.error;
	expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
	// spawnSync returns only after bash (and its foreground compile/smoke children) exit.
	// Windows may still hold the just-written tree briefly; retry only that race.
	renameSyncRetry(join(release, platform), relocated);
	writeFileSync(probeEntry, compiledLoaderProbeSource);
	const probe = spawnSync(process.execPath, ["build", "--compile", ...optimizationFlags, probeEntry, "--outfile", probeBinary], {
		cwd: repo, encoding: "utf8", timeout: 120_000,
	});
	expect(probe.status, probe.stderr).toBe(0);
	const graph = spawnSync(process.execPath, ["build", "--target=bun", ...optimizationFlags, ...releaseEntries, `--metafile=${metafile}`, "--outdir", join(scratch, "graph")], {
		cwd: join(repo, "packages/coding-agent"), encoding: "utf8", timeout: 120_000,
	});
	expect(graph.status, graph.stderr).toBe(0);
}, 550_000);

afterAll(() => {
	rmSync(probeEntry, { force: true });
	rmSync(scratch, { recursive: true, force: true });
});

test("excludes jiti implementation bytes when using the release entry graph and optimization flags", () => {
	// Given
	const schema = z.object({ outputs: z.record(z.string(), z.object({
		inputs: z.record(z.string(), z.object({ bytesInOutput: z.number() })),
	})) });
	// When
	const graph = schema.parse(JSON.parse(readFileSync(metafile, "utf8")));
	const contributors = Object.values(graph.outputs).flatMap((output) => Object.entries(output.inputs))
		.filter(([id, value]) => value.bytesInOutput > 0 && id.replaceAll("\\", "/").includes("/node_modules/jiti/"));
	// Then
	expect(contributors).toEqual([]);
	console.log(JSON.stringify({ positiveJitiInputs: contributors.length }));
});

test("preserves host identity and factory cache semantics when the production loader is compiled and relocated", () => {
	// Given
	const extension = extensionFixture();
	// When
	const result = spawnSync(probeBinary, [extension], {
		cwd: relocated, encoding: "utf8", timeout: 60_000,
		env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, SENPI_CODING_AGENT_DIR: join(scratch, "probe-agent"), PI_OFFLINE: "1" },
	});
	// Then: the child asserts reference identity against its own bundled host namespaces.
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ reloadedHelper: 42 });
	console.log(result.stdout.trim());
}, 65_000);

for (const shared of [false, true]) {
	test(`loads and reloads the special-path TypeScript fixture through ${shared ? "shared-session" : "classic"} RPC`, async () => {
		// Given: hermetic state; no provider request is needed for an extension RPC round-trip.
		const extension = extensionFixture();
		const state = mkdtempSync(join(scratch, "state-"));
		mkdirSync(join(state, "home"));
		writeFileSync(join(state, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
		const child = spawn(binary, ["--mode", "rpc", ...(shared ? ["--multi-session"] : []), "-e", extension], {
			cwd: state, stdio: ["pipe", "pipe", "pipe"], env: {
				PATH: process.env.PATH, HOME: join(state, "home"), TMPDIR: scratch, SENPI_CODING_AGENT_DIR: state, PI_OFFLINE: "1",
			},
		});
		const exit = once(child, "exit", { signal: AbortSignal.timeout(185_000) });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16000); });
		const lines = createInterface({ input: child.stdout });
		let sessionId: string | undefined;
		const request = async (command: { readonly type: string; readonly name?: string; readonly cwd?: string }) => {
			const id = command.type;
			const responses = on(lines, "line", { close: ["close"], signal: AbortSignal.timeout(60_000) });
			child.stdin.write(`${JSON.stringify({ id, ...command, sessionId })}\n`);
			try {
				for await (const args of responses) {
					const response = responseSchema.parse(JSON.parse(z.string().parse(args[0])));
					if (response.id !== id) continue;
					expect(response.success, `${JSON.stringify(response)}\n${stderr}`).toBe(true);
					return response.data;
				}
				throw new Error(`RPC closed before response: ${stderr}`);
			} finally {
				await responses.return();
			}
		};
		try {
			if (shared) sessionId = z.object({ sessionId: z.string() }).parse(await request({ type: "open_session", cwd: state })).sessionId;
			// When: exercise the actual extension request route, then reload after a helper-only edit.
			const first = probeSchema.parse(await request({ type: "extension_request", name: "extension-probe" }));
			expect(first).toEqual({ sentinel: "native-extension", value: 41, dynamicIdentity: true, typeboxKind: "string", tuiText: "probe", url: pathToFileURL(realpathSync(extension)).href, path: realpathSync(extension) });
			writeFileSync(join(extension, "..", "helper.ts"), "export const value: number = 42; export const token = {};\n");
			await request({ type: "reload" });
			const reloaded = probeSchema.parse(await request({ type: "extension_request", name: "extension-probe" }));
			// Then
			expect(reloaded.value).toBe(42);
			expect(reloaded.dynamicIdentity).toBe(true);
			console.log(JSON.stringify({ mode: shared ? "shared" : "classic", sentinel: reloaded.sentinel, helper: reloaded.value, dynamicIdentity: reloaded.dynamicIdentity }));
		} finally {
			child.kill("SIGKILL");
			await exit;
			lines.close();
		}
	}, 190_000);
}
