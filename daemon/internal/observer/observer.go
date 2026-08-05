// Package observer turns what the executors find on the box into a state
// snapshot. It reports; it never changes anything (#7).
package observer

import (
	"context"
	"sort"
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
	set   executor.Set
	clock Clock
	rev   int
}

// New returns an Observer over the given executors. A nil clock uses time.Now.
func New(set executor.Set, clock Clock) *Observer {
	if clock == nil {
		clock = time.Now
	}

	return &Observer{set: set, clock: clock}
}

// Rev is the revision of the most recent snapshot; zero before the first.
func (o *Observer) Rev() int {
	return o.rev
}

// Snapshot enumerates the box and returns a full state frame. Only Docker is
// enumerated in this slice; the other executors are wired but not read.
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
					"container_id": c.ID,
					"image":        c.Image,
					"state":        c.State,
					"status":       c.Status,
					"labels":       c.Labels,
					"created_at":   c.Created,
				},
				ObservedAt: at,
			},
		})
	}

	sort.Slice(resources, func(i, j int) bool {
		if resources[i].Kind != resources[j].Kind {
			return resources[i].Kind < resources[j].Kind
		}

		return resources[i].Name < resources[j].Name
	})

	o.rev++

	return protocol.State{Type: protocol.TypeState, Rev: o.rev, Resources: resources}, nil
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
