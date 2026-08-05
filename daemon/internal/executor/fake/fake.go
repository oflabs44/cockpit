// Package fake provides in-memory executors for tier 1 tests: no network, no
// Docker, no host (docs/development.md section 2).
package fake

import (
	"context"
	"sync"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
)

// Docker is an in-memory executor.Docker.
type Docker struct {
	mu         sync.Mutex
	Containers []executor.Container
	Err        error
	Calls      int
}

func (d *Docker) ListContainers(context.Context) ([]executor.Container, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.Calls++

	if d.Err != nil {
		return nil, d.Err
	}

	return append([]executor.Container(nil), d.Containers...), nil
}

// Set replaces the container list a later ListContainers will return.
func (d *Docker) Set(cs []executor.Container) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.Containers = append([]executor.Container(nil), cs...)
}

// Firewall is an in-memory executor.Firewall.
type Firewall struct {
	Rules []executor.FirewallRule
	Err   error
}

func (f *Firewall) ListRules(context.Context) ([]executor.FirewallRule, error) {
	return f.Rules, f.Err
}

// Systemd is an in-memory executor.Systemd.
type Systemd struct {
	Units []executor.Unit
	Err   error
}

func (s *Systemd) ListUnits(context.Context) ([]executor.Unit, error) {
	return s.Units, s.Err
}

// Cron is an in-memory executor.Cron.
type Cron struct {
	Entries []executor.CronEntry
	Err     error
}

func (c *Cron) ListEntries(context.Context) ([]executor.CronEntry, error) {
	return c.Entries, c.Err
}

// Set returns a complete executor.Set backed by fakes.
func Set() (executor.Set, *Docker) {
	d := &Docker{}

	return executor.Set{
		Docker:   d,
		Firewall: &Firewall{},
		Systemd:  &Systemd{},
		Cron:     &Cron{},
	}, d
}
