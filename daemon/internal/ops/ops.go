// Package ops executes plan changes and direct operations against the box.
//
// Every operation has ensure-semantics and is idempotent (#13, #14): it states
// what should be true, makes it so, and reports create | in_place | replace |
// no_op. Running one twice yields no_op the second time — the property that
// makes a task re-sent after a reconnect safe, and the one every test here
// asserts by running the op twice.
package ops

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// SpecLabel carries the hash of the spec a container was created from. It is
// how "is this container already what the plan asks for" is answered without
// the daemon holding any desired state of its own (#13): the answer lives on
// the box, which is the truth.
const SpecLabel = "cockpit.spec"

// Runner executes changes against the Docker executor.
type Runner struct {
	Docker executor.Docker
}

// Apply runs one plan change. It is the whole op vocabulary the daemon
// implements; anything else is refused rather than guessed at.
func (r *Runner) Apply(ctx context.Context, c protocol.Change) (string, error) {
	switch c.Op {
	case protocol.OpResourceCreate, protocol.OpResourceUpdate:
		if c.After == nil {
			return "", fmt.Errorf("%s: no after state", c.Op)
		}

		if err := supported(c.After.Kind); err != nil {
			return "", err
		}

		return r.ensure(ctx, *c.After)

	case protocol.OpResourceDelete:
		if c.Before == nil {
			return "", fmt.Errorf("%s: no before state", c.Op)
		}

		if err := supported(c.Before.Kind); err != nil {
			return "", err
		}

		return r.remove(ctx, c.Before.Name)

	case protocol.OpResourceStart, protocol.OpResourceStop, protocol.OpResourceRestart:
		target := c.After
		if target == nil {
			target = c.Before
		}

		if target == nil {
			return "", fmt.Errorf("%s: no target", c.Op)
		}

		if err := supported(target.Kind); err != nil {
			return "", err
		}

		return r.Direct(ctx, actionOf(c.Op), target.Name)
	}

	return "", fmt.Errorf("op %q is not implemented by this daemon", c.Op)
}

// Direct runs one op-frame action: restart, stop or start.
func (r *Runner) Direct(ctx context.Context, action, name string) (string, error) {
	current, exists, err := r.Docker.Inspect(ctx, name)
	if err != nil {
		return "", err
	}

	if !exists {
		return "", fmt.Errorf("container %q does not exist", name)
	}

	running := current.State == "running"

	switch action {
	case "start":
		if running {
			return protocol.ChangedNoOp, nil
		}

		return protocol.ChangedInPlace, r.Docker.Start(ctx, name)

	case "stop":
		if !running {
			return protocol.ChangedNoOp, nil
		}

		// docker stop sends SIGTERM and SIGKILLs after its default 10s.

		return protocol.ChangedInPlace, r.Docker.Stop(ctx, name)

	case "restart":
		// A restart is never a no_op: asking for one twice means two
		// restarts, and reporting the second as no_op would be a lie about
		// what happened to the box.
		return protocol.ChangedInPlace, r.Docker.Restart(ctx, name)
	}

	return "", fmt.Errorf("action %q is not one of start, stop, restart", action)
}

// ensure makes the container match the spec and says what it had to do.
func (r *Runner) ensure(ctx context.Context, t protocol.Target) (string, error) {
	want := SpecHash(t.Spec)

	current, exists, err := r.Docker.Inspect(ctx, t.Name)
	if err != nil {
		return "", err
	}

	if exists && current.Labels[SpecLabel] == want {
		if current.State == "running" {
			return protocol.ChangedNoOp, nil
		}

		// Right spec, not running: start it rather than rebuild it. Start-only
		// by design — a paused container will fail here rather than be
		// unpaused, which is acceptable for v1: cockpit never pauses anything.
		return protocol.ChangedInPlace, r.Docker.Start(ctx, t.Name)
	}

	result := protocol.ChangedCreate

	if exists {
		// A container's image, ports and env cannot be edited in place, so a
		// spec change is a replace by construction.
		//
		// TODO: pull the new image before removing the old container, so a
		// registry that is down or an image that does not exist leaves the
		// running one alone instead of taking it down first.
		result = protocol.ChangedReplace

		if err := r.Docker.Remove(ctx, t.Name); err != nil {
			return "", fmt.Errorf("replace %s: %w", t.Name, err)
		}
	}

	labels := make(map[string]string, len(t.Spec.Labels)+1)
	for k, v := range t.Spec.Labels {
		labels[k] = v
	}

	labels[SpecLabel] = want

	spec := executor.RunSpec{
		Name:    t.Name,
		Image:   t.Spec.Image,
		Env:     t.Spec.Env,
		Labels:  labels,
		Ports:   t.Spec.Ports,
		Restart: t.Spec.Restart,
		CPU:     t.Spec.Limits.CPU,
		Memory:  t.Spec.Limits.Memory,
	}

	if err := r.Docker.Run(ctx, spec); err != nil {
		if result == protocol.ChangedReplace {
			// The operator needs to know the box is now running nothing under
			// this name, not merely that a run failed.
			return "", fmt.Errorf("replace %s: old container removed, new run failed: %w", t.Name, err)
		}

		return "", err
	}

	return result, nil
}

func (r *Runner) remove(ctx context.Context, name string) (string, error) {
	_, exists, err := r.Docker.Inspect(ctx, name)
	if err != nil {
		return "", err
	}

	if !exists {
		return protocol.ChangedNoOp, nil
	}

	if err := r.Docker.Remove(ctx, name); err != nil {
		return "", err
	}

	return protocol.ChangedInPlace, nil
}

// SpecHash is a stable digest of the spec a container should be running.
//
// The spec is normalised first. An absent map and an empty one mean the same
// thing, and port order is not part of what a container is — but either would
// otherwise change the hash, and a changed hash destroys and rebuilds a live
// container for no reason.
func SpecHash(spec protocol.AppSpec) string {
	if spec.Env == nil {
		spec.Env = map[string]string{}
	}

	if spec.Labels == nil {
		spec.Labels = map[string]string{}
	}

	ports := append([]protocol.Port(nil), spec.Ports...)
	sort.Slice(ports, func(i, j int) bool {
		if ports[i].Container != ports[j].Container {
			return ports[i].Container < ports[j].Container
		}

		if ports[i].Host != ports[j].Host {
			return ports[i].Host < ports[j].Host
		}

		return ports[i].Protocol < ports[j].Protocol
	})

	if ports == nil {
		ports = []protocol.Port{}
	}

	spec.Ports = ports

	b, err := json.Marshal(spec)
	if err != nil {
		// AppSpec is plain data; marshalling it cannot fail.
		panic(err)
	}

	sum := sha256.Sum256(b)

	return hex.EncodeToString(sum[:12])
}

// supported refuses every kind but app: databases, volumes and networks are
// later slices, and guessing at them would mutate a box on a guess.
func supported(kind string) error {
	if kind != "app" {
		return fmt.Errorf("kind %q is not executable by this daemon; only app is", kind)
	}

	return nil
}

func actionOf(op string) string {
	switch op {
	case protocol.OpResourceStart:
		return "start"
	case protocol.OpResourceStop:
		return "stop"
	}

	return "restart"
}
