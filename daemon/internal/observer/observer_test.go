package observer_test

import (
	"context"
	"errors"
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
