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
	"strconv"
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
	Log *slog.Logger
}

// New returns a Client using the docker binary on PATH.
func New(log *slog.Logger) *Client {
	return &Client{Bin: "docker", Run: execRun, Log: log}
}

func (c *Client) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}

	return slog.Default()
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

// inspectFormat is one line per container, tab separated. Fields docker ps
// does not carry: when it started, how often it has restarted, under what
// policy, the local image id it resolved to, and the registry digest it was
// pulled by. The last is empty for an image built on the box, which never had
// a registry to be digested by.
const inspectFormat = "{{.Id}}\t{{.State.StartedAt}}\t{{.RestartCount}}\t{{.HostConfig.RestartPolicy.Name}}\t{{.Image}}\t{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}"

func (c *Client) ListContainers(ctx context.Context) ([]executor.Container, error) {
	out, err := c.Run(ctx, c.Bin, "ps", "--all", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}

	cs, err := ParsePS(out, c.log())
	if err != nil {
		return nil, err
	}

	if len(cs) == 0 {
		return cs, nil
	}

	// One inspect for every container, not one each: the enrichment is worth a
	// single extra exec per snapshot and no more.
	args := []string{"inspect", "--format", inspectFormat}
	for _, container := range cs {
		args = append(args, container.ID)
	}

	inspected, err := c.Run(ctx, c.Bin, args...)
	if err != nil {
		// A container removed between ps and inspect fails the whole call.
		// The ps facts are still true, so they stand.
		c.log().Warn("docker inspect failed, reporting containers without it", "err", err)

		return cs, nil
	}

	ApplyInspect(cs, inspected, c.log())

	return cs, nil
}

// ApplyInspect merges `docker inspect` output into containers, matched by id.
func ApplyInspect(cs []executor.Container, out []byte, log *slog.Logger) {
	byID := make(map[string]*executor.Container, len(cs))
	for i := range cs {
		byID[cs[i].ID] = &cs[i]
	}

	sc := bufio.NewScanner(bytes.NewReader(out))

	for sc.Scan() {
		// Trimmed on the right only: an image with no registry digest ends the
		// line with an empty final field, and TrimSpace would eat it.
		f := strings.Split(strings.TrimRight(sc.Text(), "\r\n "), "\t")
		if len(f) != 6 {
			if strings.TrimSpace(sc.Text()) != "" {
				log.Warn("unparseable docker inspect line", "line", sc.Text())
			}

			continue
		}

		container, ok := byID[f[0]]
		if !ok {
			continue
		}

		if t, err := time.Parse(time.RFC3339Nano, f[1]); err == nil && !t.IsZero() {
			container.StartedAt = t.Unix()
		}

		if n, err := strconv.Atoi(f[2]); err == nil {
			container.RestartCount = n
		}

		container.RestartPolicy = f[3]
		container.ImageID = f[4]
		container.ImageDigest = f[5]
	}
}

// ParsePS turns `docker ps --format '{{json .}}'` output into containers.
func ParsePS(out []byte, log *slog.Logger) ([]executor.Container, error) {
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
			Created: parseCreated(p.CreatedAt, log),
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
func parseCreated(s string, log *slog.Logger) int64 {
	if s == "" {
		return 0
	}

	t, err := time.Parse("2006-01-02 15:04:05 -0700 MST", s)
	if err != nil {
		log.Warn("unparseable docker CreatedAt, reporting zero", "value", s, "err", err)

		return 0
	}

	return t.Unix()
}
