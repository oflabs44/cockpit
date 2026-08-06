package oscli_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/oflabs44/cockpit/daemon/internal/executor/oscli"
	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// countingLog records that a bad line was reported rather than swallowed.
type countingLog struct{ warns int }

func (c *countingLog) Warn(string, ...any) { c.warns++ }

func fixture(t *testing.T, name string) []byte {
	t.Helper()

	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}

	return b
}

func TestParseOSRelease(t *testing.T) {
	if got := oscli.ParseOSRelease(fixture(t, "os-release.txt")); got != "Ubuntu 24.04.2 LTS" {
		t.Fatalf("os = %q", got)
	}

	if got := oscli.ParseOSRelease(nil); got != "" {
		t.Fatalf("missing file gave %q, want empty", got)
	}
}

func TestParseUptimeAndLoadavg(t *testing.T) {
	log := &countingLog{}

	if got := oscli.ParseUptime(fixture(t, "uptime.txt"), log); got != 184023 {
		t.Fatalf("uptime_s = %d", got)
	}

	load := oscli.ParseLoadavg(fixture(t, "loadavg.txt"), log)

	if load != [3]float64{0.52, 0.41, 0.38} {
		t.Fatalf("load = %v", load)
	}

	if log.warns != 0 {
		t.Fatalf("good fixtures warned %d times", log.warns)
	}

	// Garbage yields zeros and a warning, never a failure.
	if got := oscli.ParseUptime([]byte("not-a-number\n"), log); got != 0 || log.warns != 1 {
		t.Fatalf("uptime = %d after %d warns", got, log.warns)
	}

	if got := oscli.ParseLoadavg([]byte("x y z\n"), log); got != [3]float64{} {
		t.Fatalf("load = %v, want zeros", got)
	}
}

func TestParseMeminfo(t *testing.T) {
	log := &countingLog{}

	mem, swap := oscli.ParseMeminfo(fixture(t, "meminfo.txt"), log)

	if mem != 8123456*1024 {
		t.Fatalf("mem_total = %d", mem)
	}

	if swap != 2097148*1024 {
		t.Fatalf("swap_total = %d", swap)
	}

	if log.warns != 0 {
		t.Fatalf("the good fixture warned %d times", log.warns)
	}

	// A MemTotal that is not a number: reported, and the field stays zero
	// rather than the whole read failing.
	mem, swap = oscli.ParseMeminfo([]byte("MemTotal:        notanumber kB\nSwapTotal:       1024 kB\n"), log)

	if mem != 0 || swap != 1024*1024 || log.warns != 1 {
		t.Fatalf("mem=%d swap=%d warns=%d", mem, swap, log.warns)
	}
}

func TestParseDF(t *testing.T) {
	log := &countingLog{}

	disks := oscli.ParseDF(fixture(t, "df.txt"), log)

	if len(disks) != 2 {
		t.Fatalf("disks = %+v, want / and /mnt/data only", disks)
	}

	if disks[0].Mount != "/" || disks[0].Size != 50044211200 || disks[0].Used != 21470642176 {
		t.Fatalf("root disk = %+v", disks[0])
	}

	if disks[1].Mount != "/mnt/data" {
		t.Fatalf("second disk = %+v", disks[1])
	}

	// The malformed row was reported, not silently dropped.
	if log.warns != 1 {
		t.Fatalf("warns = %d, want 1 for the unparseable sizes row", log.warns)
	}
}

func TestParseSS(t *testing.T) {
	log := &countingLog{}

	ls := oscli.ParseSS(fixture(t, "ss-tlnp.txt"), log)

	if len(ls) != 4 {
		t.Fatalf("listeners = %+v, want 4", ls)
	}

	if ls[0].Addr != "0.0.0.0" || ls[0].Port != 22 || ls[0].PIDName != "sshd" || ls[0].Proto != "tcp" {
		t.Fatalf("sshd listener = %+v", ls[0])
	}

	// IPv6 addresses keep their brackets and survive the port split.
	if ls[2].Addr != "[::]" || ls[2].Port != 443 || ls[2].PIDName != "docker-proxy" {
		t.Fatalf("ipv6 listener = %+v", ls[2])
	}

	// No process column is normal when ss runs without privileges.
	if ls[3].Port != 9100 || ls[3].PIDName != "" {
		t.Fatalf("unprivileged listener = %+v", ls[3])
	}

	if log.warns != 1 {
		t.Fatalf("warns = %d, want 1 for the truncated row", log.warns)
	}
}

func TestParseSSHD(t *testing.T) {
	log := &countingLog{}

	s := oscli.ParseSSHD(fixture(t, "sshd-T.txt"), log)

	if s.PermitRootLogin != "no" || s.PasswordAuthentication != "no" || s.MaxAuthTries != 3 {
		t.Fatalf("sshd = %+v", s)
	}

	// A box without sshd reports zero values, not an error.
	if got := oscli.ParseSSHD(nil, log); got != (protocol.SSHD{}) {
		t.Fatalf("empty sshd -T gave %+v", got)
	}
}

func TestParseUFW(t *testing.T) {
	log := &countingLog{}

	rules := oscli.ParseUFW(fixture(t, "ufw-verbose.txt"), log)

	if len(rules) != 5 {
		t.Fatalf("rules = %+v, want 5 (v6 duplicates and named profiles excluded)", rules)
	}

	if rules[0].Port != 22 || rules[0].Protocol != "tcp" || rules[0].Action != "ALLOW" || rules[0].Comment != "ssh" {
		t.Fatalf("ssh rule = %+v", rules[0])
	}

	if rules[3].Port != 5432 || rules[3].Source != "10.0.0.0/8" || rules[3].Comment != "postgres from vpn" {
		t.Fatalf("postgres rule = %+v", rules[3])
	}

	// A bare port has no protocol of its own.
	if rules[4].Port != 9100 || rules[4].Protocol != "any" || rules[4].Action != "DENY" {
		t.Fatalf("deny rule = %+v", rules[4])
	}

	// The OpenSSH profile row and the nonsense row were both reported.
	if log.warns != 2 {
		t.Fatalf("warns = %d, want 2", log.warns)
	}

	if got := oscli.ParseUFW([]byte("ufw: command not found\n"), log); got != nil {
		t.Fatalf("a box without ufw gave %+v, want nothing", got)
	}
}

func TestParseSystemctlUnits(t *testing.T) {
	log := &countingLog{}

	units := oscli.ParseSystemctlUnits(fixture(t, "systemctl-units.txt"), log)

	if len(units) != 5 {
		t.Fatalf("units = %+v, want 5", units)
	}

	if units[0].Name != "docker.service" || units[0].Active != "active" || units[0].Sub != "running" {
		t.Fatalf("docker unit = %+v", units[0])
	}

	if units[2].Active != "failed" {
		t.Fatalf("fail2ban unit = %+v", units[2])
	}

	if units[0].Description != "Docker Application Container Engine" {
		t.Fatalf("description = %q", units[0].Description)
	}

	if log.warns != 1 {
		t.Fatalf("warns = %d, want 1 for the truncated row", log.warns)
	}
}

func TestParseCrontab(t *testing.T) {
	log := &countingLog{}

	entries := oscli.ParseCrontab(fixture(t, "crontab.txt"), "root", log)

	if len(entries) != 3 {
		t.Fatalf("entries = %+v, want 3 (comments and env assignments excluded)", entries)
	}

	if entries[0].Schedule != "0 3 * * *" {
		t.Fatalf("schedule = %q", entries[0].Schedule)
	}

	// The command is kept verbatim, including the double space Fields would
	// have collapsed.
	if entries[0].Command != "/usr/local/bin/backup.sh --target r2  >> /var/log/backup.log 2>&1" {
		t.Fatalf("command = %q", entries[0].Command)
	}

	if entries[0].Name != "root-1" || entries[0].User != "root" {
		t.Fatalf("name/user = %q/%q", entries[0].Name, entries[0].User)
	}

	// @shortcuts are valid crontab and must not be dropped.
	if entries[2].Schedule != "@daily" || entries[2].Command != "/usr/local/bin/renew-certs" {
		t.Fatalf("shortcut entry = %+v", entries[2])
	}

	if log.warns != 1 {
		t.Fatalf("warns = %d, want 1 for the incomplete schedule", log.warns)
	}
}

// TestObserveOnAHostWithoutAnyOfIt is the macOS development case: none of the
// probes exist. It must produce zero values and no error.
func TestHostMarshalsEmptySlicesNotNull(t *testing.T) {
	c := &oscli.CLI{
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return nil, errors.New("executable file not found in $PATH")
		},
		Read: func(string) ([]byte, error) { return nil, os.ErrNotExist },
	}
	h, _ := c.Observe(context.Background())

	b, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Contains(string(b), `"disks":null`) || strings.Contains(string(b), `"listeners":null`) {
		t.Fatalf("nil slice leaked as JSON null: %s", b)
	}
}

func TestObserveOnAHostWithoutAnyOfIt(t *testing.T) {
	c := &oscli.CLI{
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return nil, errors.New("executable file not found in $PATH")
		},
		Read: func(string) ([]byte, error) { return nil, os.ErrNotExist },
	}

	h, err := c.Observe(context.Background())

	// Not one probe worked, so the host reading is unavailable rather than a
	// box that genuinely has no memory and no disks.
	if !errors.Is(err, oscli.ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}

	if h.Identity.OS != "" || h.Capacity.MemTotal != 0 || len(h.Listeners) != 0 {
		t.Fatalf("expected zero values, got %+v", h)
	}

	// The one thing that always works: the binary knows its own CPU count.
	if h.Capacity.CPUs == 0 {
		t.Fatal("cpus = 0")
	}
}

func TestObserveReadsEveryProbe(t *testing.T) {
	c := &oscli.CLI{
		Read: func(path string) ([]byte, error) {
			switch path {
			case "/etc/os-release":
				return fixture(t, "os-release.txt"), nil
			case "/proc/meminfo":
				return fixture(t, "meminfo.txt"), nil
			case "/proc/loadavg":
				return fixture(t, "loadavg.txt"), nil
			case "/proc/uptime":
				return fixture(t, "uptime.txt"), nil
			}

			return nil, os.ErrNotExist
		},
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			switch {
			case name == "df":
				return fixture(t, "df.txt"), nil
			case name == "ss":
				return fixture(t, "ss-tlnp.txt"), nil
			case name == "sshd":
				return fixture(t, "sshd-T.txt"), nil
			case name == "uname":
				return []byte("6.8.0-51-generic\n"), nil
			case name == "stat":
				return []byte("1754400000\n"), nil
			case name == "systemctl" && args[0] == "is-active" && args[1] == "fail2ban":
				return []byte("active\n"), nil
			case name == "systemctl" && args[0] == "is-active":
				return []byte("inactive\n"), errors.New("exit 3")
			}

			return nil, errors.New("unexpected command")
		},
	}

	h, err := c.Observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if h.Identity.OS != "Ubuntu 24.04.2 LTS" || h.Identity.Kernel != "6.8.0-51-generic" || h.Identity.UptimeS != 184023 {
		t.Fatalf("identity = %+v", h.Identity)
	}

	if h.Identity.Hostname == "" {
		t.Fatal("hostname empty")
	}

	if h.Capacity.MemTotal == 0 || len(h.Capacity.Disks) != 2 {
		t.Fatalf("capacity = %+v", h.Capacity)
	}

	if h.Load[0] != 0.52 || len(h.Listeners) != 4 {
		t.Fatalf("load/listeners = %v %+v", h.Load, h.Listeners)
	}

	if !h.Security.Fail2banActive || h.Security.UnattendedUpgradesActive {
		t.Fatalf("security actives = %+v", h.Security)
	}

	if h.Security.SSHD.MaxAuthTries != 3 || h.Security.LastAptActivityUnix != 1754400000 {
		t.Fatalf("security = %+v", h.Security)
	}
}

func TestProbeAbsenceIsUnavailableNotEmpty(t *testing.T) {
	c := &oscli.CLI{
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return nil, errors.New("executable file not found in $PATH")
		},
		Read: func(string) ([]byte, error) { return nil, os.ErrNotExist },
	}

	ctx := context.Background()

	if _, err := c.ListRules(ctx); !errors.Is(err, oscli.ErrUnavailable) {
		t.Fatalf("ufw missing gave err = %v, want ErrUnavailable", err)
	}

	if _, err := c.ListUnits(ctx); !errors.Is(err, oscli.ErrUnavailable) {
		t.Fatalf("systemctl missing gave err = %v, want ErrUnavailable", err)
	}

	if _, err := c.ListEntries(ctx); !errors.Is(err, oscli.ErrUnavailable) {
		t.Fatalf("crontab missing gave err = %v, want ErrUnavailable", err)
	}

	// A probe that ran and found nothing is not unavailable.
	empty := &oscli.CLI{Run: func(context.Context, string, ...string) ([]byte, error) { return nil, nil }}

	rules, err := empty.ListRules(ctx)
	if err != nil || rules != nil {
		t.Fatalf("an empty ufw gave (%+v, %v), want (nil, nil)", rules, err)
	}
}

func TestListUnitsFillsInNeverStartedUnits(t *testing.T) {
	c := &oscli.CLI{
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if args[0] == "list-unit-files" {
				return fixture(t, "systemctl-unit-files.txt"), nil
			}

			return fixture(t, "systemctl-units.txt"), nil
		},
	}

	units, err := c.ListUnits(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	byName := map[string]string{}
	for _, u := range units {
		byName[u.Name] = u.Active
	}

	// A masked, never-started unit must report inactive rather than vanish:
	// its absence would otherwise read as the resource having been deleted.
	if got, ok := byName["cockpit-relay.service"]; !ok || got != "inactive" {
		t.Fatalf("masked unit = %q (present: %v), want inactive", got, ok)
	}

	// Loaded units keep their runtime state; the file pass does not overwrite.
	if byName["docker.service"] != "active" {
		t.Fatalf("docker.service = %q, want active", byName["docker.service"])
	}

	if len(units) != 6 {
		t.Fatalf("units = %d, want the 5 loaded plus 1 unloaded", len(units))
	}
}
