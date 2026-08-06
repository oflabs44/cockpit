package oscli

import (
	"context"
	"fmt"
	"strings"

	"github.com/oflabs44/cockpit/daemon/internal/executor"
)

// ListEntries reads root's crontab. Only root for now, matching the playbook's
// `crontab -l`; per-user crontabs and /etc/cron.d are a later widening.
func (c *CLI) ListEntries(ctx context.Context) ([]executor.CronEntry, error) {
	out, err := c.soft(ctx, "crontab", "-l")
	if err != nil {
		return nil, err
	}

	return ParseCrontab(out, "root", c.log()), nil
}

// ParseCrontab reads `crontab -l`. Entries have no name of their own, so one is
// synthesised from the user and the entry's position — stable while the file is
// stable, and re-ordering the file renames the resources.
func ParseCrontab(b []byte, user string, log logger) []executor.CronEntry {
	var out []executor.CronEntry

	for _, line := range lines(b) {
		trimmed := strings.TrimSpace(line)

		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		// Environment assignments (PATH=…, MAILTO=…) are crontab syntax but
		// not jobs.
		if before, _, ok := strings.Cut(trimmed, "="); ok && !strings.ContainsAny(before, " \t") {
			continue
		}

		schedule, command, ok := splitCron(trimmed)
		if !ok {
			log.Warn("unparseable crontab line", "line", line)

			continue
		}

		out = append(out, executor.CronEntry{
			Name:     fmt.Sprintf("%s-%d", user, len(out)+1),
			User:     user,
			Schedule: schedule,
			Command:  command,
		})
	}

	return out
}

// splitCron handles both the five-field form and the @shortcuts.
func splitCron(line string) (schedule, command string, ok bool) {
	if strings.HasPrefix(line, "@") {
		schedule, command, ok = strings.Cut(line, " ")

		return schedule, strings.TrimSpace(command), ok
	}

	f := strings.Fields(line)
	if len(f) < 6 {
		return "", "", false
	}

	schedule = strings.Join(f[:5], " ")

	// Rejoining from Fields would collapse whitespace inside the command, so
	// the tail is taken from the original line: skip five fields, keep the rest
	// verbatim.
	rest := line

	for i := 0; i < 5; i++ {
		rest = strings.TrimLeft(rest, " \t")

		if j := strings.IndexAny(rest, " \t"); j >= 0 {
			rest = rest[j:]
		} else {
			rest = ""
		}
	}

	return schedule, strings.TrimLeft(rest, " \t"), true
}
