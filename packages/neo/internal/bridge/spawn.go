package bridge

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// EnvNeoCLIPath is the env var carrying the command the Go client uses to spawn
// the daemon supervisor. The task-16 launcher sets it when it execs the Go
// binary; it is a whitespace-separated command line whose first token is the
// executable (usually `node`) and whose remaining tokens are the args BEFORE the
// daemon flags — typically `<node> <cli.js>` in production, or
// `<node> <tsx> --tsconfig <cfg> <cli.ts>` in dev. The client appends
// `--listen <socket> --register`.
//
// Example (production):  SENPI_NEO_CLI_PATH="/usr/bin/node /opt/senpi/dist/cli.js"
// Example (dev):         SENPI_NEO_CLI_PATH="node .../tsx/dist/cli.mjs --tsconfig .../tsconfig.json .../src/cli.ts"
const EnvNeoCLIPath = "SENPI_NEO_CLI_PATH"

// EnvEnableNeo gates the neo CLI flags. The daemon supervisor is launched with
// `--listen`/`--register`, which the CLI only parses when this env is truthy.
// The daemon is only ever spawned as part of an active neo session, so force the
// gate on for the child regardless of ambient env — otherwise the supervisor
// would reject its own flags on a build where neo is off by default.
const EnvEnableNeo = "SENPI_ENABLE_NEO"

// ErrNoCLIPath is returned by SpawnDaemonDetached when SENPI_NEO_CLI_PATH is
// unset — the client cannot know how to launch the daemon supervisor. The caller
// should fall back to isolated transport with a clear message.
var ErrNoCLIPath = fmt.Errorf("bridge: %s is not set; cannot spawn neo daemon (use --isolated)", EnvNeoCLIPath)

// SpawnDaemonDetached launches the daemon supervisor detached:
//
//	<cli-command...> --listen <socket> --register
//
// where <cli-command...> comes from SENPI_NEO_CLI_PATH. The child is fully
// detached (new process group / session) so it outlives this client — the daemon
// serves other clients and shuts itself down on idle. stdio is redirected to
// /dev/null (or NUL) so the child does not hold the terminal.
//
// This returns as soon as the child is started. The caller polls the registry
// for the daemon to bind + register. A spawn that loses the bind race exits with
// NEO_DAEMON_ADDRESS_IN_USE_EXIT (75); that is not an error here — the caller
// simply finds the winner's record on the next poll.
func SpawnDaemonDetached(req SpawnRequest) error {
	cliCmd := os.Getenv(EnvNeoCLIPath)
	if strings.TrimSpace(cliCmd) == "" {
		return ErrNoCLIPath
	}
	fields := splitCommand(cliCmd)
	if len(fields) == 0 {
		return ErrNoCLIPath
	}

	args := append(fields[1:], "--listen", req.Socket, "--register")
	cmd := exec.Command(fields[0], args...)
	cmd.Dir = req.Cwd
	// Force the neo gate on for the supervisor: it must parse its own
	// `--listen`/`--register` flags even when the ambient build defaults neo off.
	cmd.Env = append(os.Environ(), EnvEnableNeo+"=1")

	// Detach stdio so the daemon never touches the client's terminal.
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err == nil {
		cmd.Stdin = devNull
		cmd.Stdout = devNull
		cmd.Stderr = devNull
		defer func() { _ = devNull.Close() }()
	}

	// Put the daemon in its own process group/session so a signal to the client's
	// group (e.g. Ctrl-C) does not kill the shared daemon.
	cmd.SysProcAttr = detachedSysProcAttr()

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("bridge: start daemon supervisor: %w", err)
	}
	// Release the child: we do not wait on it (it is a shared, long-lived daemon).
	// Reaping is not our responsibility since it is detached from our group.
	if cmd.Process != nil {
		_ = cmd.Process.Release()
	}
	return nil
}

// resolveCLICommand parses SENPI_NEO_CLI_PATH into (node, preArgs, cli) for the
// isolated StdioTransport child, which spawns `node <pre...> <cli> --mode rpc`.
// The env is `<node> [pre...] <cli>`: the first token is the executable, the last
// is the CLI entry, and anything between is pre-CLI args (e.g. the tsx loader
// chain in dev). Returns ErrNoCLIPath when unset.
func resolveCLICommand() (node string, pre []string, cli string, err error) {
	cliCmd := os.Getenv(EnvNeoCLIPath)
	if strings.TrimSpace(cliCmd) == "" {
		return "", nil, "", ErrNoCLIPath
	}
	fields := splitCommand(cliCmd)
	switch len(fields) {
	case 0:
		return "", nil, "", ErrNoCLIPath
	case 1:
		// A single token is a self-contained executable used as both node and cli;
		// StdioTransport still prepends it as node with the token as CLIPath is not
		// valid, so treat the lone token as the CLI run under the default node.
		return "node", nil, fields[0], nil
	default:
		node = fields[0]
		cli = fields[len(fields)-1]
		pre = fields[1 : len(fields)-1]
		return node, pre, cli, nil
	}
}

// splitCommand splits a command line on whitespace. It is intentionally simple
// (no shell quoting) — SENPI_NEO_CLI_PATH is produced by our own launcher from
// known paths, not by a user, and our own paths do not contain spaces in the
// controlled install/dev layouts. A future need for quoted paths would swap this
// for a proper lexer.
func splitCommand(s string) []string {
	return strings.Fields(s)
}
