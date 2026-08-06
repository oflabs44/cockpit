// Package executor holds the seams between daemon logic and the box.
//
// Every capability the daemon has on a host sits behind one of these
// interfaces so handler logic runs against fakes with no box at all
// (docs/development.md section 2, tier 1). Only Docker is implemented in this
// slice; the rest exist so their shape is fixed before there are callers.
package executor

import (
	"context"

	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// Container is one Docker container as observed on the box.
type Container struct {
	ID      string
	Name    string
	Image   string
	State   string // created, running, paused, restarting, exited, dead
	Status  string // human-readable, e.g. "Up 3 hours (healthy)"
	Health  string // healthy, unhealthy, starting, or "" when no healthcheck
	Labels  map[string]string
	Created int64

	// From docker inspect. RunningFor is deliberately absent: it is
	// StartedAt subtracted from now, and the plane has both.
	StartedAt     int64
	RestartCount  int
	RestartPolicy string
	// ImageID is the local image this container resolved to. ImageDigest is
	// the registry digest it was pulled by, empty for an image built on the
	// box — which never had a registry to be digested by.
	ImageID     string
	ImageDigest string
}

// RunSpec is everything needed to create and start one container.
type RunSpec struct {
	Name    string
	Image   string
	Env     map[string]string
	Labels  map[string]string
	Ports   []protocol.Port
	Restart string
	CPU     string
	Memory  string
}

// Docker enumerates and manipulates containers.
type Docker interface {
	ListContainers(ctx context.Context) ([]Container, error)
	// Inspect returns one container by name. The bool is false when no
	// container of that name exists, which is not an error.
	Inspect(ctx context.Context, name string) (Container, bool, error)
	Run(ctx context.Context, spec RunSpec) error
	Remove(ctx context.Context, name string) error
	Start(ctx context.Context, name string) error
	Stop(ctx context.Context, name string) error
	Restart(ctx context.Context, name string) error
}

// FirewallRule is one UFW rule as observed on the box.
type FirewallRule struct {
	Port     int
	Protocol string
	Source   string
	Action   string
	Comment  string
}

// Firewall mediates UFW and provider firewalls.
type Firewall interface {
	// Active reports whether the firewall itself is enabled.
	Active(ctx context.Context) (bool, error)
	ListRules(ctx context.Context) ([]FirewallRule, error)
}

// Unit is one systemd unit as observed on the box.
type Unit struct {
	Name        string
	Load        string
	Active      string
	Sub         string
	Description string
}

// Systemd observes and manages units.
type Systemd interface {
	ListUnits(ctx context.Context) ([]Unit, error)
}

// CronEntry is one scheduled job as observed on the box.
type CronEntry struct {
	Name     string
	User     string
	Schedule string
	Command  string
}

// Cron observes and manages scheduled jobs.
type Cron interface {
	ListEntries(ctx context.Context) ([]CronEntry, error)
}

// Host reports the box itself. It returns the protocol type directly: every
// field is already a raw fact in the shape the state frame carries, so a
// parallel struct here would be a copy with a mapping function and nothing else.
type Host interface {
	Observe(ctx context.Context) (protocol.ObservedHost, error)
}

// Set is the full complement of executors available to the daemon.
type Set struct {
	Docker   Docker
	Host     Host
	Firewall Firewall
	Systemd  Systemd
	Cron     Cron
}
