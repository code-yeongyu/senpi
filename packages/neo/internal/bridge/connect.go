package bridge

import (
	"fmt"
	"time"
)

// ConnectConfig is the top-level entry the neo app layer uses to obtain a
// transport for this instance. It parses the forwarded neo argv, selects the
// transport mode (daemon vs isolated, honoring --isolated and the Windows default
// gate), and returns a live Transport plus the metadata the UI + recovery loop
// need.
type ConnectConfig struct {
	// NeoArgv is the argv the launcher forwarded (build-argv.ts output).
	NeoArgv []string
	// GOOS is the platform (runtime.GOOS); passed in for testability.
	GOOS string
	// AgentDir is the resolved senpi agent dir.
	AgentDir string
	// AgentDirEnvName / SessionDirEnvName + SessionDir let the daemon spawner pin
	// the daemon's dirs explicitly (store env var names + values) so a spawned
	// daemon registers where this client polls. Empty falls back to inheritance.
	AgentDirEnvName   string
	SessionDirEnvName string
	SessionDir        string
	// Cwd is the client's resolved absolute working directory.
	Cwd string
	// Capabilities are client capability opt-ins forwarded in the handshake
	// (e.g. "custom_unsupported"). The daemon path forwards them; the isolated
	// path ignores them (a single-child rpc runtime has no handshake).
	Capabilities []string
	// Timeout bounds the daemon attach-or-spawn. Ignored for isolated.
	Timeout time.Duration

	// newStdio builds the isolated StdioTransport given the rendered rpc argv.
	// Defaults to a real spawner; injected in tests.
	newStdio func(extra []string) (Transport, error)
	// spawn overrides the daemon spawner (defaults to SpawnDaemonDetached);
	// injected in tests.
	spawn Spawner
}

// ConnectResult carries the live transport and how it was obtained.
type ConnectResult struct {
	// Transport is the live connection; wrap it with NewClient.
	Transport Transport
	// Mode records whether this is a daemon or isolated transport.
	Mode TransportMode
	// Options is the parsed per-connection runtime options (also what the daemon
	// handshake carried), retained so the UI can render the active flags.
	Options NeoRuntimeOptions
	// Daemon is set only for the daemon mode: the attachment metadata the
	// recovery loop uses to reconnect. Nil for isolated.
	Daemon *DaemonConn
}

// Close closes the underlying transport (and, for the daemon mode, the
// attachment). It never shuts the daemon down — idle lifecycle owns that.
func (r *ConnectResult) Close() error {
	if r.Daemon != nil {
		return r.Daemon.Close()
	}
	if r.Transport != nil {
		return r.Transport.Close()
	}
	return nil
}

// Connect selects the transport and establishes it. The daemon path threads the
// parsed options into the handshake; the isolated path renders them into the
// `--mode rpc` child argv. The two therefore honor the SAME per-instance flags.
func Connect(cfg ConnectConfig) (*ConnectResult, error) {
	options, _ := ParseNeoRuntimeArgv(cfg.NeoArgv)
	mode := SelectTransportMode(cfg.NeoArgv, cfg.GOOS)

	if mode == TransportIsolated {
		newStdio := cfg.newStdio
		if newStdio == nil {
			newStdio = defaultStdioFactory(cfg.Cwd)
		}
		extra := NeoRuntimeOptionsToRpcArgv(options)
		tr, err := newStdio(extra)
		if err != nil {
			return nil, fmt.Errorf("bridge: start isolated transport: %w", err)
		}
		return &ConnectResult{Transport: tr, Mode: TransportIsolated, Options: options}, nil
	}

	conn, err := AttachOrSpawn(AttachConfig{
		AgentDir:          cfg.AgentDir,
		AgentDirEnvName:   cfg.AgentDirEnvName,
		SessionDirEnvName: cfg.SessionDirEnvName,
		SessionDir:        cfg.SessionDir,
		Cwd:               cfg.Cwd,
		Capabilities:      cfg.Capabilities,
		RuntimeOptions:    options,
		Spawn:             cfg.spawn,
		Timeout:           cfg.Timeout,
	})
	if err != nil {
		return nil, err
	}
	return &ConnectResult{
		Transport: conn.Transport,
		Mode:      TransportDaemon,
		Options:   options,
		Daemon:    conn,
	}, nil
}

// defaultStdioFactory builds the production isolated-transport factory. It resolves
// the CLI command from SENPI_NEO_CLI_PATH (the same contract the daemon spawner
// uses) and spawns `node <cli> --mode rpc <extra>` via StdioTransport.
func defaultStdioFactory(cwd string) func(extra []string) (Transport, error) {
	return func(extra []string) (Transport, error) {
		node, pre, cli, err := resolveCLICommand()
		if err != nil {
			return nil, err
		}
		return NewStdioTransport(StdioTransportConfig{
			NodePath:   node,
			PreCLIArgs: pre,
			CLIPath:    cli,
			ExtraArgs:  extra,
			Dir:        cwd,
		})
	}
}
