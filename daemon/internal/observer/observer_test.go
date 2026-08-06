package observer_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/executor/fake"
	"github.com/oflabs44/cockpit/daemon/internal/observer"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

func fixedClock(unix int64) observer.Clock {
	return func() time.Time { return time.Unix(unix, 0) }
}

func TestSnapshotReportsContainers(t *testing.T) {
	set, docker := fake.Set()
	docker.Set([]executor.Container{
		{ID: "b2", Name: "web", Image: "nginx:1", State: "running", Status: "Up 2 hours (healthy)", Health: "healthy"},
		{ID: "a1", Name: "api", Image: "api:2", State: "exited", Status: "Exited (0) 1 hour ago"},
	})

	o := observer.New(set, fixedClock(1700))

	st, err := o.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if st.Type != protocol.TypeState {
		t.Fatalf("type = %q, want %q", st.Type, protocol.TypeState)
	}

	if len(st.Resources) != 2 {
		t.Fatalf("resources = %d, want 2", len(st.Resources))
	}

	// Sorted by (kind, name), so api precedes web regardless of docker order.
	if st.Resources[0].Name != "api" || st.Resources[1].Name != "web" {
		t.Fatalf("unsorted resources: %+v", st.Resources)
	}

	api := st.Resources[0]

	if api.Kind != "app" {
		t.Fatalf("kind = %q, want app", api.Kind)
	}

	if api.Observed.Health != protocol.HealthStopped {
		t.Fatalf("exited container health = %q, want stopped", api.Observed.Health)
	}

	if !api.Observed.Exists || api.Observed.ObservedAt != 1700 {
		t.Fatalf("observed = %+v", api.Observed)
	}

	if got := api.Observed.Detail["container_id"]; got != "a1" {
		t.Fatalf("detail container_id = %v, want a1", got)
	}

	if st.Resources[1].Observed.Health != protocol.HealthHealthy {
		t.Fatalf("healthy container health = %q", st.Resources[1].Observed.Health)
	}
}

func TestSnapshotRevIsMonotonic(t *testing.T) {
	set, _ := fake.Set()
	o := observer.New(set, fixedClock(1))

	if o.Rev() != 0 {
		t.Fatalf("rev before first snapshot = %d, want 0", o.Rev())
	}

	for want := 1; want <= 3; want++ {
		st, err := o.Snapshot(context.Background())
		if err != nil {
			t.Fatal(err)
		}

		if st.Rev != want || o.Rev() != want {
			t.Fatalf("rev = %d (observer %d), want %d", st.Rev, o.Rev(), want)
		}
	}
}

func TestSnapshotHonoursKindLabel(t *testing.T) {
	set, docker := fake.Set()
	docker.Set([]executor.Container{
		{Name: "traefik", State: "running", Labels: map[string]string{observer.KindLabel: "proxy"}},
	})

	st, err := observer.New(set, fixedClock(1)).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if st.Resources[0].Kind != "proxy" {
		t.Fatalf("kind = %q, want proxy", st.Resources[0].Kind)
	}
}

func TestSnapshotComposesEveryKindAndTheHost(t *testing.T) {
	set, docker := fake.Set()
	docker.Set([]executor.Container{
		{ID: "c1", Name: "web", State: "running", StartedAt: 1600, RestartCount: 2,
			RestartPolicy: "always", ImageID: "sha256:localid", ImageDigest: "nginx@sha256:regdigest"},
	})

	set.Host.(*fake.Host).Facts = protocol.ObservedHost{
		Identity: protocol.HostIdentity{OS: "Ubuntu 24.04.2 LTS", Hostname: "lab-nbg1"},
		Load:     [3]float64{0.52, 0.41, 0.38},
	}
	set.Firewall.(*fake.Firewall).IsActive = true
	set.Firewall.(*fake.Firewall).Rules = []executor.FirewallRule{
		{Port: 22, Protocol: "tcp", Source: "Anywhere", Action: "ALLOW", Comment: "ssh"},
		// Same port, different source: two rules, so two names.
		{Port: 5432, Protocol: "tcp", Source: "10.0.0.0/8", Action: "ALLOW"},
		{Port: 5432, Protocol: "tcp", Source: "192.168.1.5", Action: "ALLOW"},
		// Same port and source, opposite action: also two rules.
		{Port: 9100, Protocol: "tcp", Source: "Anywhere", Action: "DENY"},
	}
	set.Systemd.(*fake.Systemd).Units = []executor.Unit{
		{Name: "docker.service", Load: "loaded", Active: "active", Sub: "running"},
		{Name: "fail2ban.service", Load: "loaded", Active: "failed", Sub: "failed"},
	}
	set.Cron.(*fake.Cron).Entries = []executor.CronEntry{
		{Name: "root-1", User: "root", Schedule: "0 3 * * *", Command: "/backup.sh"},
	}

	st, err := observer.New(set, fixedClock(1700)).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if st.Host == nil || st.Host.Identity.OS != "Ubuntu 24.04.2 LTS" || st.Host.Load[0] != 0.52 {
		t.Fatalf("host = %+v", st.Host)
	}

	// Sorted by (kind, name): app, cron, daemon x2, firewall_rule.
	var got []string

	for _, r := range st.Resources {
		got = append(got, r.Kind+"/"+r.Name)
	}

	want := []string{
		"app/web", "cron/root-1", "daemon/docker.service", "daemon/fail2ban.service",
		"firewall_rule/22-tcp-allow-any", "firewall_rule/5432-tcp-allow-10-0-0-0-8",
		"firewall_rule/5432-tcp-allow-192-168-1-5", "firewall_rule/9100-tcp-deny-any",
	}

	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("resources = %v, want %v", got, want)
	}

	app := st.Resources[0].Observed.Detail

	if app["started_at"] != int64(1600) || app["restart_count"] != 2 || app["restart_policy"] != "always" {
		t.Fatalf("app detail = %+v", app)
	}

	if app["image_id"] != "sha256:localid" || app["image_digest"] != "nginx@sha256:regdigest" {
		t.Fatalf("image id/digest = %v / %v", app["image_id"], app["image_digest"])
	}

	for _, kind := range []string{"docker", "host", "firewall", "systemd", "cron"} {
		if st.Probes[kind] != protocol.ProbeOK {
			t.Fatalf("probes[%s] = %q, want ok", kind, st.Probes[kind])
		}
	}

	// systemd's own words, mapped the way container health is.
	if st.Resources[2].Observed.Health != protocol.HealthHealthy {
		t.Fatalf("docker.service health = %q", st.Resources[2].Observed.Health)
	}

	if st.Resources[3].Observed.Health != protocol.HealthUnhealthy {
		t.Fatalf("fail2ban.service health = %q", st.Resources[3].Observed.Health)
	}

	// A firewall rule and a crontab line have no health of their own.
	if st.Resources[1].Observed.Health != protocol.HealthUnknown ||
		st.Resources[4].Observed.Health != protocol.HealthUnknown {
		t.Fatalf("cron/firewall health should be unknown: %+v", st.Resources)
	}

	fw := st.Resources[4].Observed.Detail

	if fw["active"] != true || fw["layer"] != "ufw" || fw["comment"] != "ssh" {
		t.Fatalf("firewall detail = %+v", fw)
	}
}

func TestSnapshotSurvivesEveryProbeButDockerFailing(t *testing.T) {
	set, docker := fake.Set()
	docker.Set([]executor.Container{{ID: "c1", Name: "web", State: "running"}})

	boom := errors.New("not on this box")
	set.Host.(*fake.Host).Err = boom
	set.Firewall.(*fake.Firewall).Err = boom
	set.Systemd.(*fake.Systemd).Err = boom
	set.Cron.(*fake.Cron).Err = boom

	st, err := observer.New(set, fixedClock(1)).WithLogger(discardLog()).Snapshot(context.Background())
	if err != nil {
		t.Fatalf("a box with no ufw, systemd or cron failed the snapshot: %v", err)
	}

	if st.Host != nil {
		t.Fatalf("host = %+v, want it omitted", st.Host)
	}

	if len(st.Resources) != 1 || st.Resources[0].Name != "web" {
		t.Fatalf("resources = %+v, want the containers alone", st.Resources)
	}

	// The distinction that stops a transient ufw failure reading as every rule
	// having been deleted.
	if st.Probes["docker"] != protocol.ProbeOK {
		t.Fatalf("probes[docker] = %q, want ok", st.Probes["docker"])
	}

	for _, kind := range []string{"host", "firewall", "systemd", "cron"} {
		if st.Probes[kind] != protocol.ProbeUnavailable {
			t.Fatalf("probes[%s] = %q, want unavailable", kind, st.Probes[kind])
		}
	}
}

func TestEmptyProbeIsOkNotUnavailable(t *testing.T) {
	set, docker := fake.Set()
	docker.Set(nil)

	st, err := observer.New(set, fixedClock(1)).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	// A box with no rules, no units and no cron jobs read fine; that is not the
	// same as not being able to read it.
	for _, kind := range []string{"docker", "host", "firewall", "systemd", "cron"} {
		if st.Probes[kind] != protocol.ProbeOK {
			t.Fatalf("probes[%s] = %q, want ok", kind, st.Probes[kind])
		}
	}
}

func TestSnapshotRejectsKindsOutsideTheClosedSet(t *testing.T) {
	// Any container on the box can set a label, so an unrecognised or
	// account-scoped kind must not reach the state frame.
	for _, label := range []string{"domain", "secret", "nonsense", "APP", "app; drop", ""} {
		set, docker := fake.Set()
		docker.Set([]executor.Container{
			{Name: "x", State: "running", Labels: map[string]string{observer.KindLabel: label}},
		})

		st, err := observer.New(set, fixedClock(1)).Snapshot(context.Background())
		if err != nil {
			t.Fatal(err)
		}

		if got := st.Resources[0].Kind; got != "app" {
			t.Fatalf("label %q produced kind %q, want app", label, got)
		}
	}

	for _, label := range []string{"database", "proxy", "volume", "network", "cron", "daemon", "firewall_rule"} {
		set, docker := fake.Set()
		docker.Set([]executor.Container{
			{Name: "x", State: "running", Labels: map[string]string{observer.KindLabel: label}},
		})

		st, err := observer.New(set, fixedClock(1)).Snapshot(context.Background())
		if err != nil {
			t.Fatal(err)
		}

		if got := st.Resources[0].Kind; got != label {
			t.Fatalf("server-scoped kind %q was rewritten to %q", label, got)
		}
	}
}

func TestSnapshotPropagatesDockerError(t *testing.T) {
	set, docker := fake.Set()
	boom := errors.New("docker down")
	docker.Err = boom

	if _, err := observer.New(set, fixedClock(1)).Snapshot(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}

func TestSnapshotHealthMapping(t *testing.T) {
	cases := map[string]struct {
		c    executor.Container
		want protocol.Health
	}{
		"running":    {executor.Container{Name: "a", State: "running"}, protocol.HealthHealthy},
		"restarting": {executor.Container{Name: "a", State: "restarting"}, protocol.HealthDegraded},
		"dead":       {executor.Container{Name: "a", State: "dead"}, protocol.HealthStopped},
		"unknown":    {executor.Container{Name: "a", State: "weird"}, protocol.HealthUnknown},
		"unhealthy":  {executor.Container{Name: "a", State: "running", Health: "unhealthy"}, protocol.HealthUnhealthy},
		"starting":   {executor.Container{Name: "a", State: "running", Health: "starting"}, protocol.HealthDegraded},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			set, docker := fake.Set()
			docker.Set([]executor.Container{tc.c})

			st, err := observer.New(set, fixedClock(1)).Snapshot(context.Background())
			if err != nil {
				t.Fatal(err)
			}

			if got := st.Resources[0].Observed.Health; got != tc.want {
				t.Fatalf("health = %q, want %q", got, tc.want)
			}
		})
	}
}

func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
