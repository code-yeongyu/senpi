/**
 * The bytes of the bundled `bun`/`bunx` shims (omo#9362; engine trust: omo#10762, design r13 5.6).
 *
 * Under an adopted trust generation a shim sets the generation file and the owned default-input
 * closure only for its own exec, and a server launch also clears Bun's system-store switches. A
 * fallback generation prints one degraded-import notice per generation. A `.cmd` value that cannot
 * be encoded yields a shim that fails with the `set-tmpdir` action instead of running the engine's
 * own entrypoint without its trust.
 */
import { engineTrustAction } from "../engine-trust/actions.ts";
import type { EngineTrustMarker } from "../engine-trust/marker.ts";

export type ShimFiles = ReadonlyArray<readonly [name: string, content: string]>;

type Variant = { readonly name: string; readonly bunxArg: boolean };
const POSIX_VARIANTS: readonly Variant[] = [
	{ name: "bun", bunxArg: false },
	{ name: "bunx", bunxArg: true },
];
const CMD_VARIANTS: readonly Variant[] = [
	{ name: "bun.cmd", bunxArg: false },
	{ name: "bunx.cmd", bunxArg: true },
];
const UNREPRESENTABLE_EXIT = 78;

function noticeText(trust: EngineTrustMarker): string | undefined {
	if (trust.fallbackReason === null) return undefined;
	const { text } = engineTrustAction(trust.fallbackReason);
	return `omo notice: certificate import is degraded (${trust.fallbackReason}); some TLS connections may fail. ${text}`;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export function posixShimFiles(execPath: string, dir: string, trust: EngineTrustMarker | undefined): ShimFiles {
	return POSIX_VARIANTS.map(({ name, bunxArg }) => {
		const target = `exec ${quote(execPath)}${bunxArg ? " x" : ""} "$@"`;
		if (trust === undefined) return [name, `#!/bin/sh\nBUN_BE_BUN=1 ${target}\n`] as const;
		const lines = ["#!/bin/sh"];
		const notice = noticeText(trust);
		if (notice !== undefined) {
			const sentinel = quote(`${dir}/.fallback-noted`);
			// `:` is a special built-in: its failed redirect would exit the shell before the exec.
			lines.push(
				`[ -e ${sentinel} ] || { printf '%s\\n' ${quote(notice)} >&2; true 2>/dev/null > ${sentinel} || :; }`,
			);
		}
		if (trust.owner === "server") lines.push("unset NODE_USE_SYSTEM_CA BUN_OPTIONS");
		const closure =
			trust.defaults === null
				? ""
				: ` SSL_CERT_FILE=${quote(trust.defaults.file)} SSL_CERT_DIR=${quote(trust.defaults.dir)}`;
		lines.push(`BUN_BE_BUN=1 NODE_EXTRA_CA_CERTS=${quote(trust.file)}${closure} ${target}`, "");
		return [name, lines.join("\n")] as const;
	});
}

/** `"` and control characters cannot sit inside a `set "NAME=value"` or a quoted path in a `.cmd`. */
const cmdRepresentable = (value: string): boolean => !/["\u0000-\u001f]/u.test(value);
const cmdValue = (value: string): string => value.replaceAll("%", "%%");
/** Text echoed inside a parenthesized block: every metacharacter is caret-escaped. */
const cmdEcho = (value: string): string => cmdValue(value).replace(/[\^&|<>()]/gu, (char) => `^${char}`);

export function cmdShimFiles(execPath: string, dir: string, trust: EngineTrustMarker | undefined): ShimFiles {
	if (trust === undefined) {
		return CMD_VARIANTS.map(({ name, bunxArg }) => {
			const run = `"${execPath}" ${bunxArg ? "x " : ""}%*`;
			return [name, `@echo off\r\nset BUN_BE_BUN=1\r\n${run}\r\nexit /b %ERRORLEVEL%\r\n`] as const;
		});
	}
	const values = [execPath, dir, trust.file, trust.defaults?.file ?? "", trust.defaults?.dir ?? ""];
	if (!values.every(cmdRepresentable)) {
		const { text } = engineTrustAction("trust-path-unrepresentable");
		const failing = `@echo off\r\n>&2 echo omo: trust-path-unrepresentable: ${cmdEcho(text)}\r\nexit /b ${UNREPRESENTABLE_EXIT}\r\n`;
		return CMD_VARIANTS.map(({ name }) => [name, failing] as const);
	}
	return CMD_VARIANTS.map(({ name, bunxArg }) => {
		const run = `"${cmdValue(execPath)}" ${bunxArg ? "x " : ""}%*`;
		const lines = ["@echo off", "setlocal"];
		const notice = noticeText(trust);
		if (notice !== undefined) {
			const sentinel = `"${cmdValue(dir)}\\.fallback-noted"`;
			lines.push(`if not exist ${sentinel} ( >&2 echo ${cmdEcho(notice)}& type nul > ${sentinel} )`);
		}
		if (trust.owner === "server") lines.push('set "NODE_USE_SYSTEM_CA="', 'set "BUN_OPTIONS="');
		lines.push('set "BUN_BE_BUN=1"', `set "NODE_EXTRA_CA_CERTS=${cmdValue(trust.file)}"`);
		if (trust.defaults !== null) {
			lines.push(
				`set "SSL_CERT_FILE=${cmdValue(trust.defaults.file)}"`,
				`set "SSL_CERT_DIR=${cmdValue(trust.defaults.dir)}"`,
			);
		}
		lines.push(run, "exit /b %ERRORLEVEL%", "");
		return [name, lines.join("\r\n")] as const;
	});
}
