// A selected runtime as a #4199 launcher finds it (design section 5, "Mixed versions"): argv[2] picks what it answers
// to the launch-capability probe (`--launch-capabilities --version`). "wrapper" is a runtime wrapper that knows nothing of
// the probe and forwards its remaining argv to the runtime it wraps, as an old `.cmd` launcher forwards `%*`.
// "capable-wrapper" answers the probe with both capabilities, as a Windows build does, and otherwise runs the wrapped
// runtime with the standard handles plus the supervisor's lifetime pipe (fd 3).
import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";

const [behavior = "legacy", ...rest] = process.argv.slice(2);
const probe = rest.includes("--launch-capabilities") && rest.includes("--version");

if (behavior === "wrapper" || (behavior === "capable-wrapper" && !probe)) {
	let lifetime = "ignore";
	try {
		fstatSync(3);
		lifetime = 3;
	} catch {}
	const result = spawnSync(process.execPath, rest, { stdio: ["inherit", "inherit", "inherit", lifetime] });
	process.exit(result.status ?? 1);
}
if (!probe) {
	// A real launch: say what it was launched with, so a test can see which flags reached the runtime.
	process.stderr.write(`launched ${JSON.stringify(rest)}\n`);
	process.exit(0);
}
switch (behavior) {
	case "both":
	case "capable-wrapper":
		process.stdout.write('{"launch_capabilities":["socket_secret_reservation_v1","participant_lifetime_locks_v1"]}\n');
		break;
	case "reservation-only":
		process.stdout.write('{"launch_capabilities":["socket_secret_reservation_v1"]}\n');
		break;
	case "legacy":
		// An old runtime ignores the unknown flag and answers its root `--version` fast path.
		process.stdout.write("0.84.4\n");
		break;
	case "malformed":
		process.stdout.write('{"launch_capabilities":\n');
		break;
	case "fail":
		process.stderr.write("runtime failed to start\n");
		process.exit(3);
		break;
	default:
		throw new Error(`unknown behavior ${behavior}`);
}
