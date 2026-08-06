// Package observer turns what the executors find on the box into a state
// snapshot. It reports; it never changes anything (#7).
package observer

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// KindLabel lets a container declare which resource kind it is. Anything
// without it is reported as an app.
const KindLabel = "cockpit.kind"

// Clock is injected so snapshots are deterministic in tests.
type Clock func() time.Time

// Observer builds successive snapshots, numbering them monotonically.
type Observer struct {
	set    executor.Set
	clock  Clock
	logger *slog.Logger
	rev    int
}

// New returns an Observer over the given executors. A nil clock uses time.Now.
func New(set executor.Set, clock Clock) *Observer {
	if clock == nil {
		clock = time.Now
	}

	return &Observer{set: set, clock: clock}
}

// WithLogger returns o logging to log, for a daemon that has configured one.
func (o *Observer) WithLogger(log *slog.Logger) *Observer {
	o.logger = log

	return o
}

func (o *Observer) log() *slog.Logger {
	if o.logger != nil {
		return o.logger
	}

	return slog.Default()
}

// Rev is the revision of the most recent snapshot; zero before the first.
func (o *Observer) Rev() int {
	return o.rev
}

// Snapshot enumerates the box and returns a full state frame: the host, plus
// containers, firewall rules, systemd units and cron entries as resources.
//
// Docker is the one hard dependency — a daemon that cannot see containers is
// not observing the box in any useful sense. Every other probe is soft: a box
// without ufw, systemd or cron reports fewer resources, not an error.
func (o *Observer) Snapshot(ctx context.Context) (protocol.State, error) {
	at := o.clock().Unix()

	cs, err := o.set.Docker.ListContainers(ctx)
	if err != nil {
		return protocol.State{}, err
	}

	resources := make([]protocol.ObservedResource, 0, len(cs))

	for _, c := range cs {
		resources = append(resources, protocol.ObservedResource{
			Kind: kindOf(c),
			Name: c.Name,
			Observed: protocol.Observed{
				Exists: true,
				Health: healthOf(c),
				Detail: map[string]any{
					"container_id":   c.ID,
					"image":          c.Image,
					"image_id":       c.ImageID,
					"image_digest":   c.ImageDigest,
					"state":          c.State,
					"status":         c.Status,
					"labels":         c.Labels,
					"created_at":     c.Created,
					"started_at":     c.StartedAt,
					"restart_count":  c.RestartCount,
					"restart_policy": c.RestartPolicy,
				},
				ObservedAt: at,
			},
		})
	}

	probes := map[string]string{"docker": protocol.ProbeOK}

	firewall, ok := o.firewall(ctx, at)
	probes["firewall"] = probeResult(ok)
	resources = append(resources, firewall...)

	units, ok := o.units(ctx, at)
	probes["systemd"] = probeResult(ok)
	resources = append(resources, units...)

	crons, ok := o.crons(ctx, at)
	probes["cron"] = probeResult(ok)
	resources = append(resources, crons...)

	host := o.host(ctx)
	probes["host"] = probeResult(host != nil)

	sort.Slice(resources, func(i, j int) bool {
		if resources[i].Kind != resources[j].Kind {
			return resources[i].Kind < resources[j].Kind
		}

		return resources[i].Name < resources[j].Name
	})

	o.rev++

	return protocol.State{
		Type:      protocol.TypeState,
		Rev:       o.rev,
		Resources: resources,
		Host:      host,
		Probes:    probes,
	}, nil
}

// probeResult distinguishes a probe that ran and found nothing from one whose
// command is missing or failed. Without it the plane cannot tell an empty box
// from a broken read, and a planner would diff against "everything deleted".
func probeResult(ok bool) string {
	if ok {
		return protocol.ProbeOK
	}

	return protocol.ProbeUnavailable
}

// host is omitted rather than half-reported when the executor fails outright;
// the executor itself already degrades to zero values probe by probe.
func (o *Observer) host(ctx context.Context) *protocol.ObservedHost {
	if o.set.Host == nil {
		return nil
	}

	h, err := o.set.Host.Observe(ctx)
	if err != nil {
		o.log().Warn("host observation failed, omitting it from the snapshot", "err", err)

		return nil
	}

	return &h
}

func (o *Observer) firewall(ctx context.Context, at int64) ([]protocol.ObservedResource, bool) {
	if o.set.Firewall == nil {
		return nil, false
	}

	active, err := o.set.Firewall.Active(ctx)
	if err != nil {
		o.log().Warn("firewall state unreadable", "err", err)
	}

	rules, err := o.set.Firewall.ListRules(ctx)
	if err != nil {
		o.log().Warn("firewall rules unreadable", "err", err)

		return nil, false
	}

	out := make([]protocol.ObservedResource, 0, len(rules))

	for _, r := range rules {
		out = append(out, protocol.ObservedResource{
			Kind: "firewall_rule",
			Name: fmt.Sprintf("%d-%s-%s-%s", r.Port, r.Protocol, strings.ToLower(r.Action), sourceSlug(r.Source)),
			Observed: protocol.Observed{
				Exists: true,
				// A rule is present or it is not; "healthy" is not a property
				// it has. Whether the set of rules is right is plane policy.
				Health: protocol.HealthUnknown,
				Detail: map[string]any{
					"port":     r.Port,
					"protocol": r.Protocol,
					"source":   r.Source,
					"action":   r.Action,
					"comment":  r.Comment,
					"layer":    "ufw",
					"active":   active,
				},
				ObservedAt: at,
			},
		})
	}

	return out, true
}

// sourceSlug makes a rule's source part of its name, so two rules for the same
// port from different sources are two resources rather than one that flickers.
// ufw's "Anywhere" becomes "any"; everything else is kebab-cased.
func sourceSlug(source string) string {
	s := strings.ToLower(strings.TrimSpace(source))

	if s == "" || s == "anywhere" {
		return "any"
	}

	s = strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			return r
		}

		return '-'
	}, s)

	return strings.Trim(s, "-")
}

func (o *Observer) units(ctx context.Context, at int64) ([]protocol.ObservedResource, bool) {
	if o.set.Systemd == nil {
		return nil, false
	}

	units, err := o.set.Systemd.ListUnits(ctx)
	if err != nil {
		o.log().Warn("systemd units unreadable", "err", err)

		return nil, false
	}

	out := make([]protocol.ObservedResource, 0, len(units))

	for _, u := range units {
		out = append(out, protocol.ObservedResource{
			Kind: "daemon",
			Name: u.Name,
			Observed: protocol.Observed{
				Exists: true,
				Health: unitHealth(u),
				Detail: map[string]any{
					"load":        u.Load,
					"active":      u.Active,
					"sub":         u.Sub,
					"description": u.Description,
				},
				ObservedAt: at,
			},
		})
	}

	return out, true
}

func (o *Observer) crons(ctx context.Context, at int64) ([]protocol.ObservedResource, bool) {
	if o.set.Cron == nil {
		return nil, false
	}

	entries, err := o.set.Cron.ListEntries(ctx)
	if err != nil {
		o.log().Warn("cron entries unreadable", "err", err)

		return nil, false
	}

	out := make([]protocol.ObservedResource, 0, len(entries))

	for _, e := range entries {
		out = append(out, protocol.ObservedResource{
			Kind: "cron",
			Name: e.Name,
			Observed: protocol.Observed{
				Exists: true,
				// A crontab line records neither its last run nor its exit
				// status (prototype-reality-check, invented #2), so there is
				// nothing here to call healthy.
				Health: protocol.HealthUnknown,
				Detail: map[string]any{
					"user":     e.User,
					"schedule": e.Schedule,
					"command":  e.Command,
				},
				ObservedAt: at,
			},
		})
	}

	return out, true
}

// unitHealth maps systemd's own words, the same way container health maps
// docker's. It interprets nothing systemd has not already decided.
func unitHealth(u executor.Unit) protocol.Health {
	switch u.Active {
	case "active":
		return protocol.HealthHealthy
	case "activating", "deactivating", "reloading":
		return protocol.HealthDegraded
	case "failed":
		return protocol.HealthUnhealthy
	case "inactive":
		return protocol.HealthStopped
	}

	return protocol.HealthUnknown
}

// kindOf trusts the label only as far as the closed server-scoped kind set:
// any container on the box can set a label, and an unvalidated one would put
// an arbitrary kind into the state frame.
func kindOf(c executor.Container) string {
	if k := c.Labels[KindLabel]; protocol.IsServerKind(k) {
		return k
	}

	return "app"
}

func healthOf(c executor.Container) protocol.Health {
	switch c.Health {
	case "healthy":
		return protocol.HealthHealthy
	case "unhealthy":
		return protocol.HealthUnhealthy
	case "starting":
		return protocol.HealthDegraded
	}

	switch c.State {
	case "running":
		return protocol.HealthHealthy
	case "restarting", "paused":
		return protocol.HealthDegraded
	case "exited", "dead", "created":
		return protocol.HealthStopped
	}

	return protocol.HealthUnknown
}
