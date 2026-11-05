import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The worker imports this plain-JS module; .ts files may not import .js, so it is loaded by URL.
const noticeModuleUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "group-signal-notice.js")).href;
let signalsProcessGroup: (commandText: string) => boolean = () => {
	throw new Error("group-signal-notice.js not loaded");
};
let groupSignalNotice: (api: string, readGroup: () => string | undefined) => string = () => {
	throw new Error("group-signal-notice.js not loaded");
};
let agentProcessGroup: (spawnSync: () => never) => string | undefined = () => {
	throw new Error("group-signal-notice.js not loaded");
};
let noticeTag = "";

beforeAll(async () => {
	const loaded: unknown = await import(noticeModuleUrl);
	if (
		typeof loaded !== "object" ||
		loaded === null ||
		!("signalsProcessGroup" in loaded) ||
		typeof loaded.signalsProcessGroup !== "function"
	) {
		throw new Error("group-signal-notice.js does not export signalsProcessGroup");
	}
	const scan = loaded.signalsProcessGroup;
	signalsProcessGroup = (commandText) => scan(commandText) === true;
	if (
		!("groupSignalNotice" in loaded) ||
		typeof loaded.groupSignalNotice !== "function" ||
		!("agentProcessGroup" in loaded) ||
		typeof loaded.agentProcessGroup !== "function" ||
		!("GROUP_SIGNAL_NOTICE_TAG" in loaded) ||
		typeof loaded.GROUP_SIGNAL_NOTICE_TAG !== "string"
	) {
		throw new Error("group-signal-notice.js does not export the notice helpers");
	}
	const notice = loaded.groupSignalNotice;
	const group = loaded.agentProcessGroup;
	groupSignalNotice = (api, readGroup) => String(notice(api, readGroup));
	agentProcessGroup = (spawnSync) => {
		const value: unknown = group(spawnSync);
		return typeof value === "string" ? value : undefined;
	};
	noticeTag = loaded.GROUP_SIGNAL_NOTICE_TAG;
});

describe("process-group signal detection (senpi#2995)", () => {
	it.each([
		["PG=$(ps -o pgid= -p $W | tr -d ' '); kill -TERM -- -$PG"],
		["kill -9 -1234"],
		["kill -- -1234"],
		["kill -s TERM -$" + "{PG}"],
		["kill -TERM -$(cat /tmp/job.pgid)"],
		["bash -lc 'kill -KILL -- -$GROUP'"],
		["pkill -g 77 sleep"],
		["killall bun"],
		["kill -TERM 1234 -5678"],
		["pkill --pgroup 5 sleep"],
		["pkill -g0 sleep"],
		["sudo killall node"],
		["kill -- -$$"],
		["  kill -TERM -- -5"],
		["if true; then kill -- -5; fi"],
		["for p in 1; do kill -- -$p; done"],
		["{ kill -- -5; }"],
		["nohup kill -- -5"],
		["xargs kill -- -5"],
		["sudo -n kill -9 -5"],
		["sh -c 'killall -TERM node'"],
		['bash -c "kill -- -5"'],
		[`sh -c 'git commit -m "x"; kill -- -5'`],
		["cat <<EOF\ntext\nEOF\nkill -- -5"],
		// senpi#3019: these still run: substitutions in double quotes or an unquoted heredoc, and commands after a comment or a heredoc.
		['echo "$(kill -- -$PG)"'],
		[`echo "$(\n# don't run yet\nkill -- -5\n)"`],
		// senpi#3019: a case pattern's unmatched ")" must not end its command substitution.
		['echo "$(case x in x) :;; esac; kill -- -5)"'],
		['echo "$(case x in x) case y in y) :;; esac;; esac; kill -- -5)"'],
		['echo "$(case case in (case) :;; esac; kill -- -5)"'],
		[`echo "$(printf '%s' case x in x; kill -- -5)"`],
		['echo "$(case x in x) (printf ok);; esac; kill -- -5)"'],
		['echo "`kill -- -5`"'],
		["cat <<EOF\n$(kill -- -$PG)\nEOF"],
		["# don't run yet\nkill -- -$PG"],
		["cat <<END-OF\ntext\nEND-OF\nkill -- -$PG"],
		["echo $((x << y))\nkill -- -5"],
		// senpi#3019: an escaped ANSI-C quote does not swallow the executable command after it.
		[String.raw`echo $'it\'s'; kill -- -5`],
		[String.raw`echo "$(printf %s $'it\'s'; kill -- -5)"`],
	])("Given %s when scanned then it is a group signal", (command) => {
		// when / then
		expect(signalsProcessGroup(command)).toBe(true);
	});

	it.each([
		["kill 1234"],
		["kill -9 1234"],
		["kill -TERM $PID"],
		["kill -l"],
		["skill -9 1234"],
		["echo killed -- -1"],
		['echo "run kill -9 on the stuck pid"'],
		['echo "use kill -9 1234 if needed"'],
		["grep -c killall notes.txt"],
		['echo "killall bun stops every bun"'],
		["kill -0 1234"],
		["kill $PID; head -5 log.txt"],
		["git log --grep kill foo -1"],
		['git commit -m "do kill -9 -5"'],
		["echo 'kill -- -5'"],
		["echo 'then kill -- -5'"],
		["cat <<EOF\nkill -- -5\nEOF"],
		["cat <<'EOF'\n  kill -9 -1\nEOF\necho done"],
		// senpi#3019: a quoted delimiter keeps the whole body inert, substitutions included.
		["cat <<'EOF'\n$(kill -- -5)\nEOF"],
		['echo "$(case x in x) :;; esac) then kill -- -5"'],
		[String.raw`echo $'it\'s; kill -- -5'`],
	])("Given %s when scanned then it is not a group signal", (command) => {
		// when / then
		expect(signalsProcessGroup(command)).toBe(false);
	});

	// senpi#3019: advisory scanning must not exhaust the worker's stack or work on hostile shell text.
	it.each([
		["deep quoted substitutions", `echo ${'"$('.repeat(50_000)}printf ok${')"'.repeat(50_000)}`],
		["unclosed substitutions", `echo "${"$(".repeat(20_000)}`],
	])("Given %s when scanned then it declines the advisory notice", (_label, command) => {
		expect(signalsProcessGroup(command)).toBe(false);
	});

	// senpi#3019 review: bounded masking must not hide a group signal that the raw command still identifies.
	it.each([
		[
			"repeated scans within the nesting limit",
			`echo ${'"$('.repeat(10)}printf ${"x".repeat(20_000)}${')"'.repeat(10)}; kill -- -5`,
		],
		["oversized command text", `echo ${"x".repeat(262_144)}; kill -- -5`],
		["repeated quote-prefix scans", `echo ${"'' ".repeat(20_000)}; kill -- -5`],
		["long unquoted heredoc", `cat <<EOF\n${"x".repeat(150_000)}\nEOF\nkill -- -$PG`],
		["seventy quoted substitutions", `printf %s ${'"$(printf %s '.repeat(70)}ok${')"'.repeat(70)}; kill -- -$PG`],
		["oversized pgroup pkill", `echo ${"x".repeat(262_144)}; pkill -g 5 sleep`],
		["oversized killall", `echo ${"x".repeat(262_144)}; killall bun`],
	])("Given %s when scanned then it keeps the group-signal notice", (_label, command) => {
		expect(signalsProcessGroup(command)).toBe(true);
	});

	it("Given no readable process group when the notice is built then it still carries its tag", () => {
		// when
		const text = groupSignalNotice("Bun.$", () => undefined);

		// then
		expect(text.startsWith(noticeTag)).toBe(true);
	});

	it("Given a ps that cannot be spawned when the agent group is read then the lookup returns nothing instead of throwing", () => {
		// given
		const missingPs = (): never => {
			throw new Error('Executable not found in $PATH: "ps"');
		};

		// when / then
		expect(agentProcessGroup(missingPs)).toBeUndefined();
	});
});
