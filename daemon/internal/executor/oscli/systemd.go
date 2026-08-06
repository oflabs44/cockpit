package oscli

import (
	"context"
	"strings"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
)

// UnitPatterns is the scope of the systemd observation. A box runs hundreds of
// units and almost none of them are cockpit's business; these are the ones the
// playbook's security and workload sections actually read.
var UnitPatterns = []string{
	"cockpit-*.service",
	"docker.service",
	"sshd.service",
	"ssh.service",
	"fail2ban.service",
	"unattended-upgrades.service",
}

// ListUnits reads the scoped unit list, then fills in the units systemd knows
// about but has not loaded — masked, disabled, never started. Without the
// second pass a hard-stopped cockpit-* unit vanishes from the snapshot instead
// of reporting inactive, which reads as deletion.
func (c *CLI) ListUnits(ctx context.Context) ([]executor.Unit, error) {
	args := append([]string{"list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"}, UnitPatterns...)

	out, err := c.soft(ctx, "systemctl", args...)
	if err != nil {
		return nil, err
	}

	units := ParseSystemctlUnits(out, c.log())

	fileArgs := append([]string{"list-unit-files", "--type=service", "--no-legend", "--no-pager", "--plain"}, UnitPatterns...)
	files, err := c.soft(ctx, "systemctl", fileArgs...)

	if err != nil {
		return units, nil
	}

	return appendUnloaded(units, ParseSystemctlUnitFiles(files, c.log())), nil
}

// ParseSystemctlUnitFiles reads `systemctl list-unit-files --plain` rows:
//
//	cockpit-agent.service  masked   enabled
//
// The second column is the install state, which is what says a unit exists at
// all. Nothing here is loaded, so its runtime state is inactive by definition.
func ParseSystemctlUnitFiles(b []byte, log logger) []executor.Unit {
	var out []executor.Unit

	for _, line := range lines(b) {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		f := strings.Fields(trimmed)
		if len(f) < 2 {
			log.Warn("unparseable systemctl unit-file line", "line", line)

			continue
		}

		out = append(out, executor.Unit{
			Name:   f[0],
			Load:   f[1], // enabled, disabled, masked, static
			Active: "inactive",
			Sub:    "dead",
		})
	}

	return out
}

// appendUnloaded adds unit files that the loaded list did not already cover.
func appendUnloaded(loaded, files []executor.Unit) []executor.Unit {
	seen := make(map[string]bool, len(loaded))
	for _, u := range loaded {
		seen[u.Name] = true
	}

	for _, u := range files {
		if !seen[u.Name] {
			loaded = append(loaded, u)
		}
	}

	return loaded
}

// ParseSystemctlUnits reads `systemctl list-units --no-legend --plain` rows:
//
//	docker.service  loaded active running Docker Application Container Engine
//
// A unit matching no pattern prints nothing, so an empty result is normal.
func ParseSystemctlUnits(b []byte, log logger) []executor.Unit {
	var out []executor.Unit

	for _, line := range lines(b) {
		trimmed := strings.TrimSpace(line)

		if trimmed == "" || strings.HasPrefix(trimmed, "●") {
			continue
		}

		f := strings.Fields(trimmed)
		if len(f) < 4 {
			log.Warn("unparseable systemctl line", "line", line)

			continue
		}

		out = append(out, executor.Unit{
			Name:        f[0],
			Load:        f[1],
			Active:      f[2],
			Sub:         f[3],
			Description: strings.Join(f[4:], " "),
		})
	}

	return out
}
