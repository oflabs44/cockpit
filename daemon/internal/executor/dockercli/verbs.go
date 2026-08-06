package dockercli

import (
	"context"
	"fmt"
	"regexp"
	"sort"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
)

// Inspect returns one container by name. A container that does not exist is
// not an error: that is the answer the ensure ops are asking for.
func (c *Client) Inspect(ctx context.Context, name string) (executor.Container, bool, error) {
	// The filter is a regex: an unescaped metacharacter in a name would make
	// the container miss itself, and a create would then hit a name conflict.
	out, err := c.Exec(ctx, c.Bin, "ps", "--all", "--no-trunc",
		"--filter", "name=^"+regexp.QuoteMeta(name)+"$", "--format", "{{json .}}")
	if err != nil {
		return executor.Container{}, false, err
	}

	cs, err := ParsePS(out, c.log())
	if err != nil {
		return executor.Container{}, false, err
	}

	for i := range cs {
		if cs[i].Name != name {
			continue
		}

		// The ensure ops read the spec label off ps output; the inspect
		// enrichment is best-effort on top of it.
		if inspected, err := c.Exec(ctx, c.Bin, "inspect", "--format", inspectFormat, cs[i].ID); err != nil {
			c.log().Warn("docker inspect failed, reporting the container without it", "name", name, "err", err)
		} else {
			ApplyInspect(cs[i:i+1], inspected, c.log())
		}

		return cs[i], true, nil
	}

	return executor.Container{}, false, nil
}

// Run creates and starts a container. Ports, env, labels and limits are argv,
// not a config file: cockpit owns no container config on the box.
func (c *Client) Run(ctx context.Context, spec executor.RunSpec) error {
	args := []string{"run", "--detach", "--name", spec.Name}

	if spec.Restart != "" {
		args = append(args, "--restart", spec.Restart)
	}

	if spec.CPU != "" {
		args = append(args, "--cpus", spec.CPU)
	}

	if spec.Memory != "" {
		args = append(args, "--memory", spec.Memory)
	}

	for _, k := range sortedKeys(spec.Env) {
		args = append(args, "--env", k+"="+spec.Env[k])
	}

	for _, k := range sortedKeys(spec.Labels) {
		args = append(args, "--label", k+"="+spec.Labels[k])
	}

	for _, p := range spec.Ports {
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}

		if p.Host == 0 {
			args = append(args, "--expose", fmt.Sprintf("%d/%s", p.Container, proto))

			continue
		}

		args = append(args, "--publish", fmt.Sprintf("%d:%d/%s", p.Host, p.Container, proto))
	}

	// Everything after -- is an operand, so an image string that looks like a
	// flag cannot become one.
	args = append(args, "--", spec.Image)

	_, err := c.Exec(ctx, c.Bin, args...)

	return err
}

func (c *Client) Remove(ctx context.Context, name string) error {
	_, err := c.Exec(ctx, c.Bin, "rm", "--force", name)

	return err
}

func (c *Client) Start(ctx context.Context, name string) error {
	_, err := c.Exec(ctx, c.Bin, "start", name)

	return err
}

func (c *Client) Stop(ctx context.Context, name string) error {
	_, err := c.Exec(ctx, c.Bin, "stop", name)

	return err
}

func (c *Client) Restart(ctx context.Context, name string) error {
	_, err := c.Exec(ctx, c.Bin, "restart", name)

	return err
}

// sortedKeys keeps argv stable, so the same spec produces the same command.
func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}

	sort.Strings(out)

	return out
}
