// Package executor holds the seams between daemon logic and the box.
//
// Every capability the daemon has on a host sits behind one of these
// interfaces so handler logic runs against fakes with no box at all
// (docs/development.md section 2, tier 1). Only Docker is implemented in this
// slice; the rest exist so their shape is fixed before there are callers.
package executor

import "context"

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
}

// Docker enumerates and (later) manipulates containers, volumes and networks.
type Docker interface {
	ListContainers(ctx context.Context) ([]Container, error)
}

// FirewallRule is one UFW or cloud-firewall rule as observed on the box.
type FirewallRule struct {
	Port     int
	Protocol string
	Source   string
	Action   string
}

// Firewall mediates UFW and provider firewalls. Not implemented in this slice.
type Firewall interface {
	ListRules(ctx context.Context) ([]FirewallRule, error)
}

// Unit is one systemd unit as observed on the box.
type Unit struct {
	Name      string
	Load      string
	Active    string
	Sub       string
	Enabled   bool
	Substates map[string]string
}

// Systemd observes and manages units. Not implemented in this slice.
type Systemd interface {
	ListUnits(ctx context.Context) ([]Unit, error)
}

// CronEntry is one scheduled job as observed on the box.
type CronEntry struct {
	Name     string
	Schedule string
	Command  string
	Timezone string
}

// Cron observes and manages scheduled jobs. Not implemented in this slice.
type Cron interface {
	ListEntries(ctx context.Context) ([]CronEntry, error)
}

// Set is the full complement of executors available to the daemon.
type Set struct {
	Docker   Docker
	Firewall Firewall
	Systemd  Systemd
	Cron     Cron
}
