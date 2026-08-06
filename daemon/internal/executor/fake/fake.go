// Package fake provides in-memory executors for tier 1 tests: no network, no
// Docker, no host (docs/development.md section 2).
package fake

import (
	"context"
	"fmt"
	"sync"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// Docker is an in-memory executor.Docker.
type Docker struct {
	mu         sync.Mutex
	Containers []executor.Container
	Err        error
	RunErr     error
	RemoveErr  error
	Calls      int
	// Ops is every mutating call, in order. Ran is every RunSpec created.
	Ops []string
	Ran []executor.RunSpec
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

// The verbs below make the fake a small in-memory box rather than a canned
// answer: an op run twice against it really does find its own first effect,
// which is what makes the idempotency assertions worth anything.

func (d *Docker) Inspect(_ context.Context, name string) (executor.Container, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.Err != nil {
		return executor.Container{}, false, d.Err
	}

	for _, c := range d.Containers {
		if c.Name == name {
			return c, true, nil
		}
	}

	return executor.Container{}, false, nil
}

func (d *Docker) Run(_ context.Context, spec executor.RunSpec) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.Err != nil {
		return d.Err
	}

	if d.RunErr != nil {
		return d.RunErr
	}

	// Real docker refuses a duplicate name; a fake that silently accepts one
	// would let a broken ensure look idempotent.
	for _, c := range d.Containers {
		if c.Name == spec.Name {
			return fmt.Errorf("conflict: a container named %q already exists", spec.Name)
		}
	}

	d.Ops = append(d.Ops, "run "+spec.Name)
	d.Ran = append(d.Ran, spec)
	d.Containers = append(d.Containers, executor.Container{
		ID:            "id-" + spec.Name,
		Name:          spec.Name,
		Image:         spec.Image,
		State:         "running",
		Labels:        spec.Labels,
		RestartPolicy: spec.Restart,
	})

	return nil
}

func (d *Docker) Remove(_ context.Context, name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if err := d.mutErr(); err != nil {
		return err
	}

	if d.RemoveErr != nil {
		return d.RemoveErr
	}

	d.Ops = append(d.Ops, "remove "+name)

	out := d.Containers[:0]
	found := false

	for _, c := range d.Containers {
		if c.Name == name {
			found = true

			continue
		}

		out = append(out, c)
	}

	d.Containers = out

	if !found {
		return fmt.Errorf("no such container: %s", name)
	}

	return nil
}

// mutErr lets a test fail every mutating verb the way a dead dockerd does.
func (d *Docker) mutErr() error {
	return d.Err
}

func (d *Docker) Start(_ context.Context, name string) error {
	return d.setState(name, "start", "running")
}

func (d *Docker) Stop(_ context.Context, name string) error {
	return d.setState(name, "stop", "exited")
}

func (d *Docker) Restart(_ context.Context, name string) error {
	return d.setState(name, "restart", "running")
}

func (d *Docker) setState(name, op, state string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if err := d.mutErr(); err != nil {
		return err
	}

	d.Ops = append(d.Ops, op+" "+name)

	for i := range d.Containers {
		if d.Containers[i].Name == name {
			d.Containers[i].State = state

			return nil
		}
	}

	return fmt.Errorf("no such container: %s", name)
}

// Host is an in-memory executor.Host.
type Host struct {
	Facts protocol.ObservedHost
	Err   error
}

func (h *Host) Observe(context.Context) (protocol.ObservedHost, error) {
	return h.Facts, h.Err
}

// Firewall is an in-memory executor.Firewall.
type Firewall struct {
	Rules     []executor.FirewallRule
	IsActive  bool
	ActiveErr error
	Err       error
}

func (f *Firewall) Active(context.Context) (bool, error) {
	return f.IsActive, f.ActiveErr
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

// Set returns a complete executor.Set backed by fakes, along with the Docker
// fake most tests drive. The others are reachable through the returned Set.
func Set() (executor.Set, *Docker) {
	d := &Docker{}

	return executor.Set{
		Docker:   d,
		Host:     &Host{},
		Firewall: &Firewall{},
		Systemd:  &Systemd{},
		Cron:     &Cron{},
	}, d
}
