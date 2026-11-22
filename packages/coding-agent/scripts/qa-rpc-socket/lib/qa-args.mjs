/**
 * Argument parsing for `tool-child-qa.mjs`. `--inject A,B:v` names test-only switches, each set as
 * `SENPI_TOOL_CHILD_TEST_<NAME>` (value `1`, or the `:<value>` suffix); `--env K=V` repeats.
 */

const RUNTIMES = new Set(["in-process", "child"]);
const INJECT_PREFIX = "SENPI_TOOL_CHILD_TEST_";

export function parseInject(spec) {
	return spec
		.split(",")
		.filter(Boolean)
		.map((item) => {
			const colon = item.indexOf(":");
			return colon === -1 ? { name: item, value: "1" } : { name: item.slice(0, colon), value: item.slice(colon + 1) };
		});
}

export function injectEnv(inject) {
	return Object.fromEntries(inject.map(({ name, value }) => [`${INJECT_PREFIX}${name}`, value]));
}

/** `{ ok: true, value }` or `{ ok: false, message }`; never throws on user input. */
export function parseQaArgs(argv) {
	const value = { runtime: undefined, scenario: undefined, inject: [], env: {}, extension: undefined, expectFailure: undefined, out: undefined };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) return { ok: false, message: `${flag} needs a value` };
		index++;
		switch (flag) {
			case "--runtime":
				if (!RUNTIMES.has(next)) return { ok: false, message: `--runtime must be in-process or child, got ${next}` };
				value.runtime = next;
				break;
			case "--scenario":
				value.scenario = next;
				break;
			case "--inject":
				value.inject.push(...parseInject(next));
				break;
			case "--env": {
				const equals = next.indexOf("=");
				if (equals <= 0) return { ok: false, message: `--env expects K=V, got ${next}` };
				value.env[next.slice(0, equals)] = next.slice(equals + 1);
				break;
			}
			case "--extension":
				value.extension = next;
				break;
			case "--expect-failure":
				value.expectFailure = next;
				break;
			case "--out":
				value.out = next;
				break;
			default:
				return { ok: false, message: `unknown flag ${flag}` };
		}
	}
	if (value.scenario === undefined || value.out === undefined) return { ok: false, message: "--scenario and --out are required" };
	return { ok: true, value };
}
