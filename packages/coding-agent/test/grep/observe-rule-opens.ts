import { spawn } from "node:child_process";
import { once } from "node:events";

// Returned matches alone cannot prove a pruned directory's ignore files weren't
// opened. Observe those files while the real helper runs; an ordinary searched
// file is the positive control. No fixture bytes cross this observer.
const observer = `
import ctypes, os, struct, sys
lib = ctypes.CDLL(None, use_errno=True)
fd = lib.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
assert fd >= 0
def watch(path):
    wd = lib.inotify_add_watch(fd, os.fsencode(path), 0x20 | 0x1)
    assert wd >= 0
    return wd
control = watch(sys.argv[1])
private = {watch(path) for path in sys.argv[2:]}
print("READY", flush=True)
sys.stdin.read()
seen = set()
while True:
    try: events = os.read(fd, 65536)
    except BlockingIOError: break
    offset = 0
    while offset < len(events):
        wd, mask, _, length = struct.unpack_from("iIII", events, offset)
        offset += 16 + length
        if mask & (0x20 | 0x1): seen.add(wd)
os.close(fd)
sys.exit(2 if seen & private else (0 if control in seen else 3))
`;

export async function observeRuleOpens<T>(
	ordinary: string,
	protectedFiles: string[],
	run: () => Promise<T>,
): Promise<T> {
	if (process.platform !== "linux") return run();
	const child = spawn("python3", ["-I", "-c", observer, ordinary, ...protectedFiles], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	const closed = once(child, "close");
	try {
		await Promise.race([
			once(child.stdout, "data"),
			closed.then(() => {
				throw new Error("file-open observer failed to start");
			}),
		]);
		const result = await run();
		child.stdin.end();
		const [code] = await closed;
		if (code !== 0)
			throw new Error(code === 2 ? "walker opened a protected file" : "ordinary-file observation control failed");
		return result;
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}
