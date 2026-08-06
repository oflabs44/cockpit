package oscli

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/oflabs44/cockpit/daemon/internal/protocol"
)

// Observe assembles the host half of a state snapshot. Every probe is
// independently soft: a missing one leaves its fields zero. If not one of them
// worked — a Mac in development, say — the whole host probe is unavailable, so
// the plane does not read empty fields as facts.
func (c *CLI) Observe(ctx context.Context) (protocol.ObservedHost, error) {
	var ran int

	read := func(path string) []byte {
		b, err := c.softRead(path)
		if err == nil {
			ran++
		}

		return b
	}

	run := func(name string, args ...string) []byte {
		out, err := c.soft(ctx, name, args...)
		if err == nil {
			ran++
		}

		return out
	}

	hostname, _ := os.Hostname()
	mem, swap := ParseMeminfo(read("/proc/meminfo"), c.log())

	h := protocol.ObservedHost{
		Identity: protocol.HostIdentity{
			OS:       ParseOSRelease(read("/etc/os-release")),
			Kernel:   strings.TrimSpace(string(run("uname", "-r"))),
			Hostname: hostname,
			UptimeS:  ParseUptime(read("/proc/uptime"), c.log()),
		},
		Capacity: protocol.HostCapacity{
			CPUs:      runtime.NumCPU(),
			MemTotal:  mem,
			SwapTotal: swap,
			Disks:     ParseDF(run("df", "-B1", "--output=source,target,size,used"), c.log()),
		},
		Load:      ParseLoadavg(read("/proc/loadavg"), c.log()),
		Listeners: ParseSS(run("ss", "-tlnp"), c.log()),
		Security: protocol.HostSecurity{
			SSHD:                     ParseSSHD(run("sshd", "-T"), c.log()),
			Fail2banActive:           c.isActive(ctx, "fail2ban"),
			UnattendedUpgradesActive: c.isActive(ctx, "unattended-upgrades"),
			LastAptActivityUnix:      c.fileMtime(ctx, "/var/log/apt/history.log"),
		},
	}

	// The wire contract (type-design §3.1) says arrays; a Go nil slice marshals
	// to JSON null, which the plane rightly rejects as malformed.
	if h.Capacity.Disks == nil {
		h.Capacity.Disks = []protocol.Disk{}
	}

	if h.Listeners == nil {
		h.Listeners = []protocol.Listener{}
	}

	if ran == 0 {
		return h, fmt.Errorf("%w: host", ErrUnavailable)
	}

	return h, nil
}

// isActive is systemctl's own answer, not an interpretation of it: the unit is
// active or it is not.
func (c *CLI) isActive(ctx context.Context, unit string) bool {
	out, _ := c.Run(ctx, "systemctl", "is-active", unit)

	return strings.TrimSpace(string(out)) == "active"
}

func (c *CLI) fileMtime(ctx context.Context, path string) int64 {
	out, _ := c.soft(ctx, "stat", "-c", "%Y", path)

	n, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}

	return n
}

// ParseOSRelease returns PRETTY_NAME from /etc/os-release.
func ParseOSRelease(b []byte) string {
	for _, line := range lines(b) {
		k, v, ok := strings.Cut(line, "=")
		if ok && k == "PRETTY_NAME" {
			return strings.Trim(strings.TrimSpace(v), `"`)
		}
	}

	return ""
}

// ParseUptime reads the first field of /proc/uptime, in seconds.
func ParseUptime(b []byte, log logger) int64 {
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0
	}

	secs, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		log.Warn("unparseable /proc/uptime", "value", f[0])

		return 0
	}

	return int64(secs)
}

// ParseLoadavg reads the 1, 5 and 15 minute averages from /proc/loadavg.
func ParseLoadavg(b []byte, log logger) [3]float64 {
	var out [3]float64

	f := strings.Fields(string(b))

	for i := 0; i < 3 && i < len(f); i++ {
		v, err := strconv.ParseFloat(f[i], 64)
		if err != nil {
			log.Warn("unparseable /proc/loadavg field", "value", f[i])

			continue
		}

		out[i] = v
	}

	return out
}

// ParseMeminfo returns MemTotal and SwapTotal in bytes. /proc/meminfo is in kB.
func ParseMeminfo(b []byte, log logger) (mem, swap int64) {
	for _, line := range lines(b) {
		key, rest, ok := strings.Cut(line, ":")
		if !ok || (key != "MemTotal" && key != "SwapTotal") {
			continue
		}

		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}

		kb, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			log.Warn("unparseable /proc/meminfo line", "line", line)

			continue
		}

		if key == "MemTotal" {
			mem = kb * 1024
		} else {
			swap = kb * 1024
		}
	}

	return mem, swap
}

// dfSkip are the pseudo-filesystems the playbook's df already filtered out:
// they are kernel bookkeeping, not disks an operator can fill.
var dfSkip = map[string]bool{
	"tmpfs": true, "devtmpfs": true, "udev": true, "overlay": true,
	"none": true, "shm": true, "efivarfs": true,
}

// ParseDF reads `df -B1 --output=source,target,size,used`.
func ParseDF(b []byte, log logger) []protocol.Disk {
	var out []protocol.Disk

	for i, line := range lines(b) {
		f := strings.Fields(line)

		if i == 0 || len(f) == 0 {
			continue // header
		}

		if len(f) != 4 {
			log.Warn("unparseable df line", "line", line)

			continue
		}

		if dfSkip[f[0]] {
			continue
		}

		size, err1 := strconv.ParseInt(f[2], 10, 64)
		used, err2 := strconv.ParseInt(f[3], 10, 64)

		if err1 != nil || err2 != nil {
			log.Warn("unparseable df sizes", "line", line)

			continue
		}

		out = append(out, protocol.Disk{Mount: f[1], Size: size, Used: used})
	}

	return out
}

// ParseSS reads `ss -tlnp`. Address forms seen in the wild: 0.0.0.0:22,
// [::]:22, *:22, 127.0.0.1:8428, and %lo:53 on some systems.
func ParseSS(b []byte, log logger) []protocol.Listener {
	var out []protocol.Listener

	for i, line := range lines(b) {
		f := strings.Fields(line)

		if i == 0 || len(f) == 0 {
			continue // header
		}

		if len(f) < 4 {
			log.Warn("unparseable ss line", "line", line)

			continue
		}

		// State Recv-Q Send-Q Local:Port Peer:Port [users:(("name",pid=…))]
		addr, portStr, ok := strings.Cut(lastColon(f[3]), "\x00")
		if !ok {
			log.Warn("unparseable ss local address", "line", line)

			continue
		}

		port, err := strconv.Atoi(portStr)
		if err != nil {
			log.Warn("unparseable ss port", "line", line)

			continue
		}

		out = append(out, protocol.Listener{
			Proto:   "tcp",
			Addr:    addr,
			Port:    port,
			PIDName: ssProcess(line),
		})
	}

	return out
}

// lastColon splits an address on its final colon, so IPv6 forms survive. The
// NUL is a separator no address contains.
func lastColon(s string) string {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return s
	}

	return s[:i] + "\x00" + s[i+1:]
}

// ssProcess pulls the first process name out of ss's users:(("nginx",pid=…)).
func ssProcess(line string) string {
	_, rest, ok := strings.Cut(line, `users:(("`)
	if !ok {
		return ""
	}

	name, _, _ := strings.Cut(rest, `"`)

	return name
}

// ParseSSHD reads the subset of `sshd -T` the security baseline needs. sshd
// prints keys lowercased, one per line.
func ParseSSHD(b []byte, log logger) protocol.SSHD {
	var out protocol.SSHD

	for _, line := range lines(b) {
		key, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok {
			continue
		}

		switch strings.ToLower(key) {
		case "permitrootlogin":
			out.PermitRootLogin = value
		case "passwordauthentication":
			out.PasswordAuthentication = value
		case "maxauthtries":
			n, err := strconv.Atoi(value)
			if err != nil {
				log.Warn("unparseable sshd maxauthtries", "value", value)

				continue
			}

			out.MaxAuthTries = n
		}
	}

	return out
}

func lines(b []byte) []string {
	var out []string

	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for sc.Scan() {
		out = append(out, sc.Text())
	}

	return out
}

// logger is the slice of slog every parser needs, so parsers can be called
// from tests with a discard logger and nothing else.
type logger interface {
	Warn(msg string, args ...any)
}
