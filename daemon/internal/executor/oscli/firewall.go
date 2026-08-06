package oscli

import (
	"context"
	"strconv"
	"strings"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
)

// Active reports whether ufw is enabled. A box without ufw is inactive, not an
// error.
func (c *CLI) Active(ctx context.Context) (bool, error) {
	out, _ := c.soft(ctx, "ufw", "status")

	return strings.Contains(string(out), "Status: active"), nil
}

// ListRules reads `ufw status verbose`. A ufw that is absent or errored is
// reported as unavailable, not as a box with no rules.
func (c *CLI) ListRules(ctx context.Context) ([]executor.FirewallRule, error) {
	out, err := c.soft(ctx, "ufw", "status", "verbose")
	if err != nil {
		return nil, err
	}

	return ParseUFW(out, c.log()), nil
}

// ParseUFW reads the rule table of `ufw status verbose`. Rows look like:
//
//	22/tcp                     ALLOW IN    Anywhere                   # ssh
//	443                        ALLOW IN    10.0.0.0/8
//	22/tcp (v6)                ALLOW IN    Anywhere (v6)
//
// The v6 duplicates are skipped: they are the same rule, and reporting both
// would double every rule count on the plane.
func ParseUFW(b []byte, log logger) []executor.FirewallRule {
	var (
		out    []executor.FirewallRule
		inBody bool
	)

	for _, line := range lines(b) {
		trimmed := strings.TrimSpace(line)

		if strings.HasPrefix(trimmed, "--") {
			inBody = true

			continue
		}

		if !inBody || trimmed == "" {
			continue
		}

		rule, comment, _ := strings.Cut(trimmed, "#")

		fields := strings.Fields(rule)
		if len(fields) < 3 {
			log.Warn("unparseable ufw rule", "line", line)

			continue
		}

		if strings.Contains(rule, "(v6)") {
			continue
		}

		port, proto, ok := splitPortProto(fields[0])
		if !ok {
			// Named services (OpenSSH, "Nginx Full") and forwarding rules do
			// not carry a port here; the plane cannot act on them either.
			log.Warn("skipping non port/proto ufw rule", "target", fields[0])

			continue
		}

		// "ALLOW IN" / "DENY IN" occupy two fields, the source the rest.
		action := fields[1]
		source := strings.Join(fields[3:], " ")

		if source == "" {
			source = "Anywhere"
		}

		out = append(out, executor.FirewallRule{
			Port:     port,
			Protocol: proto,
			Source:   source,
			Action:   action,
			Comment:  strings.TrimSpace(comment),
		})
	}

	return out
}

// splitPortProto reads "22/tcp" and bare "443".
func splitPortProto(s string) (port int, proto string, ok bool) {
	portStr, proto, hasProto := strings.Cut(s, "/")

	n, err := strconv.Atoi(portStr)
	if err != nil {
		return 0, "", false
	}

	if !hasProto {
		proto = "any"
	}

	return n, proto, true
}
