package bridge

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

// Transport is the byte-level duplex channel the Client speaks over: it writes
// JSONL command lines and reads JSONL response/event lines. StdioTransport wraps
// a spawned `node <cli> --mode rpc` child; a future named-pipe transport (task
// 15-17) will satisfy the same interface for daemon attach.
type Transport interface {
	io.ReadWriteCloser
}

// ErrProcessExited is the sentinel wrapped by the typed exit error when the RPC
// child terminates.
var ErrProcessExited = errors.New("bridge: rpc process exited")

// initWaitDefault mirrors rpc-client.ts: wait 100ms after spawn for the process
// to initialize, then verify it has not already exited.
const initWaitDefault = 100 * time.Millisecond

// StdioTransportConfig configures a spawned RPC child.
type StdioTransportConfig struct {
	// CLIPath is the path to the CLI entry (e.g. dist/cli.js or src/cli.ts).
	CLIPath string
	// NodePath is the node executable (default "node").
	NodePath string
	// PreCLIArgs are inserted before CLIPath (e.g. tsx loader args when running
	// TypeScript source). Empty for a built dist/cli.js.
	PreCLIArgs []string
	// ExtraArgs are appended after `--mode rpc` (e.g. --provider, --model).
	ExtraArgs []string
	// Dir is the working directory for the child.
	Dir string
	// Env is the child environment (nil inherits the parent's).
	Env []string
	// InitWait overrides the post-spawn initialization wait (default 100ms).
	InitWait time.Duration
}

// stdioSpawnArgs builds the argv passed to node: <cli> --mode rpc [extra...].
// (PreCLIArgs, if any, are prepended by the caller for the tsx loader case.)
func stdioSpawnArgs(cliPath string, extra []string) []string {
	args := make([]string, 0, 3+len(extra))
	args = append(args, cliPath, "--mode", "rpc")
	args = append(args, extra...)
	return args
}

// StdioTransport is a Transport backed by a spawned RPC child process. It pipes
// stdin/stdout for the protocol and captures stderr for diagnostics and the
// typed exit error (rpc-client.ts parity).
type StdioTransport struct {
	stdin    io.WriteCloser
	stdout   io.ReadCloser
	exitErr  error
	cmd      *exec.Cmd
	stderr   *syncBuffer
	closedCh chan struct{}
	mu       sync.Mutex
	exited   bool
}

// syncBuffer is a bytes.Buffer guarded by its own mutex so a stderr drain
// goroutine and reader goroutines never race. Write satisfies io.Writer so it is
// an io.Copy sink.
type syncBuffer struct {
	buf bytes.Buffer
	mu  sync.Mutex
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// appendString appends diagnostic text without an error return (bytes.Buffer
// never fails to write), keeping best-effort callers errcheck-clean.
func (s *syncBuffer) appendString(str string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf.WriteString(str)
}

// NewStdioTransport spawns `node <pre...> <cli> --mode rpc <extra...>`, waits the
// init interval, and returns the transport. It fails if the child exits during
// initialization (typed error includes captured stderr).
func NewStdioTransport(cfg StdioTransportConfig) (*StdioTransport, error) {
	node := cfg.NodePath
	if node == "" {
		node = "node"
	}
	argv := append([]string{}, cfg.PreCLIArgs...)
	argv = append(argv, stdioSpawnArgs(cfg.CLIPath, cfg.ExtraArgs)...)

	cmd := exec.Command(node, argv...)
	cmd.Dir = cfg.Dir
	cmd.Env = cfg.Env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("bridge: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("bridge: stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("bridge: stderr pipe: %w", err)
	}

	t := &StdioTransport{
		cmd:      cmd,
		stdin:    stdin,
		stdout:   stdout,
		stderr:   &syncBuffer{},
		closedCh: make(chan struct{}),
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("bridge: start %s: %w", node, err)
	}

	// Drain stderr into the buffer for diagnostics + exit-error context. io.Copy
	// returns when the pipe closes (child exit). A copy error (e.g. read on a
	// broken pipe) is appended to the buffer so it still surfaces in diagnostics.
	go func() {
		if _, cerr := io.Copy(t.stderr, stderrPipe); cerr != nil {
			t.stderr.appendString(fmt.Sprintf("\n[bridge: stderr drain ended: %v]", cerr))
		}
	}()

	// Reap the process and record a typed exit error once it terminates.
	go func() {
		werr := cmd.Wait()
		t.mu.Lock()
		t.exited = true
		t.exitErr = t.buildExitErrorLocked(werr)
		t.mu.Unlock()
		close(t.closedCh)
	}()

	// rpc-client.ts: wait 100ms, then verify the process is still alive.
	wait := cfg.InitWait
	if wait <= 0 {
		wait = initWaitDefault
	}
	select {
	case <-t.closedCh:
		return nil, t.ExitError()
	case <-time.After(wait):
	}
	return t, nil
}

// buildExitErrorLocked composes the typed exit error including captured stderr.
// Caller holds t.mu.
func (t *StdioTransport) buildExitErrorLocked(werr error) error {
	stderr := t.stderr.String()
	if werr == nil {
		return fmt.Errorf("%w (code=0); stderr: %s", ErrProcessExited, stderr)
	}
	return fmt.Errorf("%w: %v; stderr: %s", ErrProcessExited, werr, stderr)
}

// Read implements io.Reader over the child's stdout.
func (t *StdioTransport) Read(p []byte) (int, error) { return t.stdout.Read(p) }

// Write implements io.Writer over the child's stdin.
func (t *StdioTransport) Write(p []byte) (int, error) {
	t.mu.Lock()
	if t.exited {
		err := t.exitErr
		t.mu.Unlock()
		return 0, err
	}
	t.mu.Unlock()
	return t.stdin.Write(p)
}

// Close terminates the child (SIGTERM, then SIGKILL after a grace window) and
// releases pipes. Shutdown-path errors on an already-dying process are expected
// (the child may have exited on its own) and are folded into the returned error
// only when they are not "process already finished".
func (t *StdioTransport) Close() error {
	var errs []error
	if err := t.stdin.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		errs = append(errs, err)
	}
	if t.cmd.Process != nil {
		if err := t.cmd.Process.Signal(sigTerm()); err != nil && !isProcessDone(err) {
			errs = append(errs, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		select {
		case <-t.closedCh:
		case <-ctx.Done():
			if err := t.cmd.Process.Kill(); err != nil && !isProcessDone(err) {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// isProcessDone reports whether err indicates the child already exited, so
// Close's best-effort signalling can ignore it.
func isProcessDone(err error) bool {
	return errors.Is(err, os.ErrProcessDone)
}

// Stderr returns the stderr captured so far.
func (t *StdioTransport) Stderr() string {
	return t.stderr.String()
}

// ExitError returns the typed exit error if the child has exited, else nil.
func (t *StdioTransport) ExitError() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.exited {
		return nil
	}
	return t.exitErr
}

// Done is closed when the child process exits.
func (t *StdioTransport) Done() <-chan struct{} { return t.closedCh }

// Signal sends sig to the child process. It is a no-op if the process has not
// started or has already exited. Useful for graceful abort/interrupt from the
// app layer (and exercised by manual QA to simulate a mid-request crash).
func (t *StdioTransport) Signal(sig os.Signal) error {
	if t.cmd.Process == nil {
		return nil
	}
	if err := t.cmd.Process.Signal(sig); err != nil && !isProcessDone(err) {
		return err
	}
	return nil
}
