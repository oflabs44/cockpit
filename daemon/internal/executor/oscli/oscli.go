// Package oscli implements the host, firewall, systemd and cron executors by
// reading /proc and /etc and shelling out to df, ss, sshd, systemctl, ufw and
// crontab — the same reads the operator's inspect-server playbook ran by hand,
// with the parsing pinned down.
//
// Two rules run through all of it. Facts only: no thresholds, no health policy,
// no derived percentages — those are the plane's. And no probe may fail a
// snapshot: a box without ufw, or a laptop without /proc, yields zero values
// and a debug line, never an error.
package oscli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
)

// Runner runs a command and returns stdout. Injected so every parser below is
// testable against captured output with none of these binaries present.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// FileReader reads a file. Injected for the same reason.
type FileReader func(path string) ([]byte, error)

// CLI is the shared plumbing behind the four executors in this package.
type CLI struct {
	Run  Runner
	Read FileReader
	Log  *slog.Logger
}

// New returns a CLI wired to the real host.
func New(log *slog.Logger) *CLI {
	return &CLI{Run: execRun, Read: os.ReadFile, Log: log}
}

func execRun(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	// ufw, systemctl and crontab all use exit status to say "no" as well as to
	// say "broken", so stdout is returned either way and the caller decides.
	if err != nil {
		return stdout.Bytes(), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}

	return stdout.Bytes(), nil
}

func (c *CLI) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}

	return slog.Default()
}

// ErrUnavailable means the probe's command is missing or failed, as opposed to
// running and finding nothing. The caller reports the difference to the plane,
// which is what stops a transient ufw failure reading as "every rule deleted".
var ErrUnavailable = errors.New("probe unavailable on this host")

// soft runs a command whose absence or failure is expected on some hosts:
// macOS in development, a box without ufw, a container without systemd.
func (c *CLI) soft(ctx context.Context, name string, args ...string) ([]byte, error) {
	out, err := c.Run(ctx, name, args...)
	if err != nil {
		c.log().Debug("host probe unavailable", "cmd", name, "args", args, "err", err)

		return out, fmt.Errorf("%w: %s: %v", ErrUnavailable, name, err)
	}

	return out, nil
}

// softRead reads a file whose absence is expected on some hosts.
func (c *CLI) softRead(path string) ([]byte, error) {
	b, err := c.Read(path)
	if err != nil {
		c.log().Debug("host file unavailable", "path", path, "err", err)

		return b, fmt.Errorf("%w: %s: %v", ErrUnavailable, path, err)
	}

	return b, nil
}
