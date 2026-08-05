// Package dockercli implements executor.Docker over the docker CLI.
package dockercli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
)

// Runner runs a command and returns its stdout. Injected so the CLI parsing is
// testable without Docker present.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

// Client is an executor.Docker backed by the docker binary.
type Client struct {
	Bin string
	Run Runner
}

// New returns a Client using the docker binary on PATH.
func New() *Client {
	return &Client{Bin: "docker", Run: execRun}
}

func execRun(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}

	return stdout.Bytes(), nil
}

// psLine is one line of `docker ps --format '{{json .}}'`.
type psLine struct {
	ID        string `json:"ID"`
	Names     string `json:"Names"`
	Image     string `json:"Image"`
	State     string `json:"State"`
	Status    string `json:"Status"`
	Labels    string `json:"Labels"`
	CreatedAt string `json:"CreatedAt"`
}

func (c *Client) ListContainers(ctx context.Context) ([]executor.Container, error) {
	out, err := c.Run(ctx, c.Bin, "ps", "--all", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}

	return ParsePS(out)
}

// ParsePS turns `docker ps --format '{{json .}}'` output into containers.
func ParsePS(out []byte) ([]executor.Container, error) {
	var cs []executor.Container

	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}

		var p psLine

		if err := json.Unmarshal(line, &p); err != nil {
			return nil, fmt.Errorf("parse docker ps line: %w", err)
		}

		cs = append(cs, executor.Container{
			ID:      p.ID,
			Name:    firstName(p.Names),
			Image:   p.Image,
			State:   p.State,
			Status:  p.Status,
			Health:  healthFromStatus(p.Status),
			Labels:  parseLabels(p.Labels),
			Created: parseCreated(p.CreatedAt),
		})
	}

	if err := sc.Err(); err != nil {
		return nil, err
	}

	return cs, nil
}

func firstName(names string) string {
	if i := strings.IndexByte(names, ','); i >= 0 {
		return names[:i]
	}

	return names
}

func healthFromStatus(status string) string {
	switch {
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	}

	return ""
}

func parseLabels(s string) map[string]string {
	if s == "" {
		return nil
	}

	m := map[string]string{}

	for _, kv := range strings.Split(s, ",") {
		k, v, _ := strings.Cut(kv, "=")

		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}

		m[k] = v
	}

	return m
}

// docker prints CreatedAt as "2006-01-02 15:04:05 -0700 MST". An unparseable
// value is reported as zero rather than failing the whole snapshot, but it
// means the format moved, so say so.
func parseCreated(s string) int64 {
	if s == "" {
		return 0
	}

	t, err := time.Parse("2006-01-02 15:04:05 -0700 MST", s)
	if err != nil {
		slog.Warn("unparseable docker CreatedAt, reporting zero", "value", s, "err", err)

		return 0
	}

	return t.Unix()
}
