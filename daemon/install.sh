#!/bin/sh
#
# cockpit installer: makes a box able to talk to the plane, and nothing else.
# Docker, the cockpitd binary, its unit, enrolment.
#
#   curl -fsSL https://github.com/oflabs44/cockpit/releases/latest/download/install.sh \
#     | sh -s -- --plane https://cockpit.oflabs.dev --token ck_enrol_8fkq2t
#
# It does no host hardening — no sshd, no users, no UFW — and it does not
# configure Docker beyond installing it. It reports nothing to anybody, and
# never prints the enrolment token.
#
# Re-running is safe: it upgrades the binary and unit, skips the restart when
# nothing changed, and never re-enrols a box that already holds a credential.

set -eu

# Substituted at publish time.
COCKPITD_VERSION="__COCKPITD_VERSION__"
SHA256_AMD64="__COCKPITD_SHA256_AMD64__"
SHA256_ARM64="__COCKPITD_SHA256_ARM64__"

# Release assets are flat under the tag, so $BASE_URL/$COCKPITD_VERSION/<asset>
# is a GitHub release download URL unchanged.
DEFAULT_BASE_URL="https://github.com/oflabs44/cockpit/releases/download"
BASE_URL="${COCKPIT_BASE_URL:-$DEFAULT_BASE_URL}"

BIN=/usr/local/bin/cockpitd
UNINSTALL=/usr/local/bin/cockpitd-uninstall.sh
CONFIG_DIR=/etc/cockpitd
CONFIG_FILE="$CONFIG_DIR/config.json"
TOKEN_FILE="$CONFIG_DIR/enrolment-token"
UNIT=/etc/systemd/system/cockpitd.service
DROPIN_DIR=/etc/systemd/system/cockpitd.service.d
DROPIN="$DROPIN_DIR/10-enrolment-token.conf"
RUNTIME_DIR=/run/cockpitd
STATE_FILE="$RUNTIME_DIR/state.json"

WAIT_SECONDS=30

# Docker 24 is the floor: nothing here is tested against older daemons.
MIN_DOCKER_MAJOR=24

# Builds run on the target box (architecture #17). Under this, the install
# succeeds and the first deployment dies as a container killed for no stated
# reason.
MIN_FREE_MB=5120

PLANE=""
TOKEN=""

# Set when something this run did makes a restart unavoidable whatever the
# fingerprints say.
RESTART_REQUIRED=""

log() {
	echo "cockpit: $*"
}

die() {
	echo "cockpit: $*" >&2
	exit 1
}

usage() {
	cat >&2 <<'EOF'
usage: install.sh --plane <url> [--token <tok>]

  --plane <url>   plane base URL, e.g. https://cockpit.oflabs.dev
  --token <tok>   single-use enrolment token; omit it to enrol by claim code

  COCKPIT_BASE_URL       override where the cockpitd binary is fetched from
  COCKPIT_FORCE_RESTART  restart cockpitd even when nothing changed

Uninstall with /usr/local/bin/cockpitd-uninstall.sh.
EOF
	exit 2
}

parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--plane)
			[ $# -ge 2 ] || die "--plane needs a value"
			PLANE="$2"
			shift 2
			;;
		--plane=*)
			PLANE="${1#--plane=}"
			shift
			;;
		--token)
			[ $# -ge 2 ] || die "--token needs a value"
			TOKEN="$2"
			shift 2
			;;
		--token=*)
			TOKEN="${1#--token=}"
			shift
			;;
		--help | -h)
			usage
			;;
		*)
			echo "cockpit: unknown argument: $1" >&2
			usage
			;;
		esac
	done
}

# Everything here runs before the box is touched, so a run that ends in a usage
# message costs nothing.
validate_args() {
	for placeholder in "$COCKPITD_VERSION" "$SHA256_AMD64" "$SHA256_ARM64"; do
		case "$placeholder" in
		__*__)
			die "this copy of install.sh has not been published: its version and digests are still placeholders.
  Use install.sh from a release, or substitute them by hand to test against your own build."
			;;
		esac
	done

	if [ -z "$PLANE" ]; then
		# A re-run inherits the plane from the config, which needs jq to read,
		# so all that can be checked here is that there is one to inherit.
		[ -f "$CONFIG_FILE" ] || usage
	else
		require_url "$PLANE" "--plane"
	fi

	require_url "$BASE_URL" "COCKPIT_BASE_URL"
}

require_url() {
	case "$1" in
	http://* | https://*) ;;
	*) die "$2 must be an http(s) URL, got: $1" ;;
	esac
}

preflight_host() {
	[ "$(id -u)" = 0 ] || die "must run as root: re-run with sudo"

	command -v systemctl >/dev/null 2>&1 ||
		die "no systemd on this box; cockpitd is installed as a systemd unit"

	[ -r /etc/os-release ] || die "no /etc/os-release; cannot identify this distro"

	# In a subshell: os-release sets VERSION, ID and NAME, and sourcing it here
	# would overwrite the pinned version above.
	# shellcheck disable=SC1091 # read at run time on the target box
	os_id=$(. /etc/os-release && echo "${ID:-unknown}:${ID_LIKE:-}")

	case "$os_id" in
	debian:* | ubuntu:* | *:*debian* | *:*ubuntu*) ;;
	*) die "unsupported distro ${os_id%%:*}; cockpit supports Debian and Ubuntu" ;;
	esac

	case "$(uname -m)" in
	x86_64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die "unsupported architecture $(uname -m); cockpit supports amd64 and arm64" ;;
	esac

	command -v sha256sum >/dev/null 2>&1 || die "no sha256sum; cannot verify the download"

	preflight_disk
}

preflight_disk() {
	target=/var/lib/docker
	[ -d "$target" ] || target=/var/lib
	[ -d "$target" ] || target=/

	free_mb=$(df -Pk "$target" 2>/dev/null | awk 'NR == 2 {print int($4 / 1024)}')

	case "$free_mb" in
	'' | *[!0-9]*)
		log "could not read free disk on $target; continuing"
		return 0
		;;
	esac

	if [ "$free_mb" -lt "$MIN_FREE_MB" ]; then
		die "only ${free_mb}MB free on $target, and cockpit needs at least ${MIN_FREE_MB}MB.
  Images and builds land here. Free space or resize the disk, then re-run."
	fi

	log "disk: ${free_mb}MB free on $target"
}

APT_UPDATED=""
INSTALLED_PACKAGES=""

apt_install() {
	INSTALLED_PACKAGES="$INSTALLED_PACKAGES $*"

	if [ -z "$APT_UPDATED" ]; then
		log "updating apt index"
		DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null
		APT_UPDATED=yes
	fi

	log "installing $*"
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null </dev/null
}

# curl and jq are the only things installed before the reachability probes,
# because the probes need them.
ensure_tools() {
	command -v curl >/dev/null 2>&1 || apt_install curl ca-certificates
	command -v jq >/dev/null 2>&1 || apt_install jq
}

preflight_network() {
	probe_url "$PLANE" plane
	probe_url "$BASE_URL" "release host"

	command -v docker >/dev/null 2>&1 ||
		probe_url https://get.docker.com "docker installer host"
}

probe_url() {
	url="$1"
	what="$2"
	rc=0

	# No -f: any HTTP answer proves reachability, and the plane root is
	# entitled to return 404. This tests DNS, TCP and TLS.
	curl -sS --max-time 10 -o /dev/null "$url" 2>/dev/null || rc=$?

	if [ "$rc" = 0 ]; then
		log "$what is reachable: $url"

		return 0
	fi

	case "$rc" in
	6) why="DNS lookup failed" ;;
	7) why="connection refused or no route" ;;
	28) why="timed out after 10s" ;;
	35 | 60) why="TLS handshake or certificate check failed" ;;
	*) why="curl exited $rc" ;;
	esac

	if [ -z "$INSTALLED_PACKAGES" ]; then
		left="Nothing on this box has been changed."
	else
		left="Nothing on this box has been changed except the packages these checks needed:$INSTALLED_PACKAGES."
	fi

	die "cannot reach the $what at $url: $why.
  $left Fix connectivity, or check the URL, and re-run."
}

# `docker info`, not `command -v docker`: a binary on PATH with a dead daemon
# is the failure this catches.
ensure_docker() {
	if docker info >/dev/null 2>&1; then
		log "docker is already running"
	else
		if ! command -v docker >/dev/null 2>&1; then
			log "installing docker from get.docker.com"

			# mktemp, not a fixed /tmp name: a local user who pre-creates a
			# predictable path as a symlink gets root to write through it.
			get_docker=$(mktemp)

			curl -fsSL https://get.docker.com -o "$get_docker" ||
				die "could not download docker's installer from https://get.docker.com"

			# The one unpinned remote script here, deliberately: Docker's
			# install path varies by distro and release, and carrying our own
			# repository, keyring and version matrix is more to get wrong.
			sh "$get_docker" </dev/null ||
				die "docker's own installer failed; its output is above"

			rm -f "$get_docker"
		fi

		systemctl enable --now docker

		docker info >/dev/null 2>&1 ||
			die "docker is installed but not answering; check: systemctl status docker"
	fi

	# Enabling is separate from running: a box where docker was started by hand
	# loses it, and every container with it, at the next reboot.
	systemctl is-enabled --quiet docker || systemctl enable docker

	check_docker_version
}

check_docker_version() {
	version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "")

	[ -n "$version" ] || die "docker is running but did not report a version; check: docker version"

	major="${version%%.*}"

	case "$major" in
	'' | *[!0-9]*)
		log "could not read the docker major version from '$version'; continuing"
		return 0
		;;
	esac

	if [ "$major" -lt "$MIN_DOCKER_MAJOR" ]; then
		die "docker $version is too old; cockpit needs $MIN_DOCKER_MAJOR or newer.
  Upgrade with: curl -fsSL https://get.docker.com | sh"
	fi

	log "docker $version"
}

require_json_object() {
	jq empty "$1" 2>/dev/null ||
		die "$1 is not valid JSON; fix it and re-run"

	jq -e 'type == "object"' "$1" >/dev/null 2>&1 ||
		die "$1 is valid JSON but not an object; fix it and re-run"
}

# The staging file holds the token and the credential, so it is removed even
# when install(1) fails. mktemp creates it 0600, which is what makes staging a
# secret there safe.
write_file() {
	wf_path="$1"
	wf_mode="$2"
	wf_tmp=$(mktemp)

	trap 'rm -f "$wf_tmp"' EXIT
	# Signal handlers exit rather than fall through: without the exit, POSIX sh resumes the
	# script after the handler and install(1) runs against the file just deleted.
	trap 'rm -f "$wf_tmp"; exit 130' INT
	trap 'rm -f "$wf_tmp"; exit 143' TERM

	cat >"$wf_tmp"
	install -m "$wf_mode" "$wf_tmp" "$wf_path"

	rm -f "$wf_tmp"
	trap - EXIT INT TERM
}

install_binary() {
	case "$ARCH" in
	amd64) want_sha="$SHA256_AMD64" ;;
	arm64) want_sha="$SHA256_ARM64" ;;
	*) die "no digest published for $ARCH" ;;
	esac

	if [ -x "$BIN" ] && [ "$(sha256sum "$BIN" | cut -d' ' -f1)" = "$want_sha" ]; then
		log "cockpitd $COCKPITD_VERSION is already installed"

		return 0
	fi

	url="$BASE_URL/$COCKPITD_VERSION/cockpitd-linux-$ARCH"
	tmp=$(mktemp)
	trap 'rm -f "$tmp"' EXIT
	trap 'rm -f "$tmp"; exit 130' INT
	trap 'rm -f "$tmp"; exit 143' TERM

	log "downloading cockpitd $COCKPITD_VERSION ($ARCH)"

	curl -fsSL "$url" -o "$tmp" || die "download failed: $url"

	printf '%s  %s\n' "$want_sha" "$tmp" | sha256sum -c - >/dev/null 2>&1 ||
		die "checksum mismatch for $url; refusing to install"

	install -m 0755 "$tmp" "$BIN"

	rm -f "$tmp"
	trap - EXIT INT TERM

	log "installed $BIN"
}

write_unit() {
	write_file "$UNIT" 0644 <<EOF
[Unit]
Description=cockpit daemon
Documentation=https://github.com/oflabs44/cockpit
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=exec
ExecStart=$BIN
Restart=always
RestartSec=5s
RuntimeDirectory=cockpitd
RuntimeDirectoryMode=0700

[Install]
WantedBy=multi-user.target
EOF

	systemctl daemon-reload
}

# Sets the plane URL and touches nothing else: this file also holds the
# credential, and a re-run that dropped it would orphan the box.
write_config() {
	mkdir -p "$CONFIG_DIR"
	chmod 0700 "$CONFIG_DIR"

	if [ -f "$CONFIG_FILE" ]; then
		require_json_object "$CONFIG_FILE"

		current=$(jq -r '.plane // empty' "$CONFIG_FILE")

		if [ "$current" = "$PLANE" ]; then
			log "plane URL in $CONFIG_FILE is already $PLANE"

			return 0
		fi

		# An enrolled box never reaches here (require_same_plane), so this is an
		# unenrolled one being re-pointed. A daemon running through that write
		# may be enrolling, and its own config.Save would be lost.
		if systemctl is-active --quiet cockpitd; then
			die "cockpitd is running and the plane is changing from $current to $PLANE.
  Stop it first: systemctl stop cockpitd — then re-run."
		fi

		updated=$(jq --arg plane "$PLANE" '.plane = $plane' "$CONFIG_FILE")
	else
		updated=$(jq -n --arg plane "$PLANE" '{plane: $plane}')
	fi

	log "setting the plane URL in $CONFIG_FILE to $PLANE"
	printf '%s\n' "$updated" | write_file "$CONFIG_FILE" 0600
}

# Generated from this run's paths, so it removes what was installed and nothing
# else. The heredoc is unquoted: install-time values are baked in, and what the
# uninstaller must evaluate itself is escaped.
write_uninstall() {
	write_file "$UNINSTALL" 0755 <<EOF
#!/bin/sh
#
# Removes the cockpit agent installed by install.sh.

set -eu

[ "\$(id -u)" = 0 ] || { echo "cockpitd-uninstall: must run as root" >&2; exit 1; }

# Set on the last line: a run that aborts partway must not also remove the
# thing that would have finished the job.
removed=""
trap 'if [ -n "\$removed" ]; then rm -f "$UNINSTALL"; fi' EXIT

systemctl stop cockpitd 2>/dev/null || true
systemctl disable cockpitd 2>/dev/null || true

# A symlink here belongs to whoever made it.
if [ -L "$BIN" ]; then
	echo "cockpitd-uninstall: $BIN is a symlink, not the binary we installed; leaving it"
elif [ -f "$BIN" ]; then
	rm -f "$BIN"
fi

rm -f "$UNIT"
rm -rf "$DROPIN_DIR"
rm -rf "$CONFIG_DIR"
rm -rf "$RUNTIME_DIR"

systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed cockpitd 2>/dev/null || true

removed=yes

cat <<'NOTE'
cockpit: the agent is removed.

  Docker, your containers, images, volumes and networks were NOT touched.
  Everything cockpit deployed on this box is still running.

  This server still exists in your plane. Remove it there too, or it will
  sit as a server that has stopped reporting.
NOTE
EOF

	log "wrote $UNINSTALL"
}

# This script does not work out for itself whether the box is enrolled or
# connected. It asks the binary, which computes one verdict next to the code
# that already knows; deriving it here from config.json and state.json is what
# produced three rounds of bugs where the two definitions drifted.
STATUS_JSON='{}'

refresh_status() {
	STATUS_JSON='{}'

	# Expected on a fresh box, before install_binary.
	if [ ! -x "$BIN" ]; then
		return 0
	fi

	rc=0
	answer=$("$BIN" status --json --config "$CONFIG_FILE" --state "$STATE_FILE" 2>/dev/null) || rc=$?

	if [ "$rc" = 0 ] && printf '%s' "$answer" | jq -e 'type == "object" and has("disposition")' >/dev/null 2>&1; then
		STATUS_JSON="$answer"

		return 0
	fi

	die "cockpitd could not report its status, so this run does not know whether this box is
  enrolled, and will not guess. See why with:
    $BIN status --config $CONFIG_FILE --state $STATE_FILE"
}

# has($k), not `.[$k] // empty`: jq's alternative operator treats false as
# absent, so every boolean would come back empty and read as "not false".
status_field() {
	printf '%s' "$STATUS_JSON" | jq -r --arg k "$1" 'if has($k) then .[$k] else "" end' 2>/dev/null
}

# Sets the global rather than echoing: a die() inside $( ) kills only the
# subshell, and the script would then abort on the assignment's exit status
# with nothing said.
resolve_plane() {
	[ -z "$PLANE" ] || return 0

	[ -f "$CONFIG_FILE" ] ||
		die "no plane URL given and no $CONFIG_FILE to inherit one from; pass --plane <url>"

	require_json_object "$CONFIG_FILE"

	PLANE=$(jq -r '.plane // empty' "$CONFIG_FILE")

	[ -n "$PLANE" ] ||
		die "no plane URL in $CONFIG_FILE and none given; pass --plane <url>"

	require_url "$PLANE" "the plane URL in $CONFIG_FILE"
}

# A credential is worthless to any plane but the one that issued it, so moving
# an enrolled box by rewriting this field would leave it pointed at a plane
# that will refuse it.
require_same_plane() {
	[ -f "$CONFIG_FILE" ] || return 0

	require_json_object "$CONFIG_FILE"

	[ -n "$(jq -r '.credential // empty' "$CONFIG_FILE")" ] || return 0

	enrolled_plane=$(jq -r '.plane // empty' "$CONFIG_FILE")

	[ "$enrolled_plane" != "$PLANE" ] || return 0

	die "this server is already enrolled with $enrolled_plane, and --plane says $PLANE.
  Its credential is worthless to the new plane, so this would leave the box unable to
  connect to either. To move it: $UNINSTALL, then install again against $PLANE."
}

# Everything a restart would pick up. Comparing it either side of the install
# is what makes a no-op re-run genuinely no-op instead of dropping the daemon's
# session for nothing.
fingerprint() {
	for f in "$BIN" "$UNIT" "$CONFIG_FILE"; do
		if [ -f "$f" ]; then
			sha256sum "$f"
		else
			echo "absent $f"
		fi
	done | sha256sum | cut -d' ' -f1
}

# Returns 0 when it restarted, 1 when it deliberately did not.
restart_if_needed() {
	systemctl is-enabled --quiet cockpitd || systemctl enable cockpitd

	if [ -n "$RESTART_REQUIRED" ]; then
		why="$RESTART_REQUIRED"
	elif [ -n "${COCKPIT_FORCE_RESTART:-}" ]; then
		why="forced by COCKPIT_FORCE_RESTART"
	elif [ "$FINGERPRINT_BEFORE" != "$FINGERPRINT_AFTER" ]; then
		why="the binary, unit or config changed"
	elif ! systemctl is-active --quiet cockpitd; then
		why="cockpitd is not running"
	else
		log "nothing changed and cockpitd is running: leaving its session alone"
		log "  restart anyway with: COCKPIT_FORCE_RESTART=1 sh install.sh ..."

		return 1
	fi

	restart_daemon "$why"

	return 0
}

restart_daemon() {
	log "restarting cockpitd ($1)"
	systemctl restart cockpitd
}

# Returns 0 when the wanted disposition arrives, 2 when a different settled one
# does, and 1 on timeout. The 2 matters: connected and awaiting_claim are
# places the daemon stops rather than passes through, so polling for one while
# it has already reached the other wastes thirty seconds to produce a worse
# message than it could have given at once.
wait_for_disposition() {
	want="$1"
	waited=0

	while [ "$waited" -lt "$WAIT_SECONDS" ]; do
		refresh_status
		seen=$(status_field disposition)

		if [ "$seen" = "$want" ]; then
			return 0
		fi

		case "$seen" in
		connected | awaiting_claim) return 2 ;;
		esac

		sleep 1
		waited=$((waited + 1))
	done

	return 1
}

timeout_message() {
	# A daemon that exits before publishing anything — an unwritable /etc is
	# the way that happens — leaves status with nothing to go on, and its
	# disposition advice would then send the operator to re-enrol a server the
	# plane has already bound. Ask systemd instead: the reason is in the log.
	if ! systemctl is-active --quiet cockpitd; then
		die "cockpitd is not running: it exited, or systemd is restarting it in a loop.
$(journalctl -u cockpitd -n 15 --no-pager 2>&1 | sed 's/^/  /')

  If it could not write its credential, free space or fix permissions on $CONFIG_DIR
  and enrol again with a fresh token — the plane has already spent the one used here."
	fi

	refresh_status

	case "$(status_field disposition)" in
	'' | unknown)
		die "cockpitd published nothing within ${WAIT_SECONDS}s — it may have failed to start.
  Check it with: journalctl -u cockpitd -n 50"
		;;
	*)
		die "cockpitd is still '$(status_field disposition)' after ${WAIT_SECONDS}s.
  $(status_field advice)"
		;;
	esac
}

# The token goes on disk rather than in argv, which is world-readable through
# /proc, and into a drop-in rather than the unit, so a single-use secret does
# not sit in a unit file across every reboot.
enrol_with_token() {
	mkdir -p "$DROPIN_DIR"

	write_file "$DROPIN" 0644 <<EOF
[Service]
ExecStart=
ExecStart=$BIN --token-file $TOKEN_FILE
EOF

	# After the last write_file, which clears traps of its own. From here a
	# failure must not leave a single-use secret on disk, or a drop-in that
	# restarts cockpitd against it for ever.
	#
	# The signal handlers exit. Without that, POSIX sh resumes the script after
	# the handler has removed the token file, and it goes on to start cockpitd
	# with --token-file pointing at nothing.
	trap 'clear_enrolment_dropin' EXIT
	trap 'clear_enrolment_dropin; exit 130' INT
	trap 'clear_enrolment_dropin; exit 143' TERM

	# umask rather than a later chmod: the token must never exist
	# world-readable, even briefly.
	old_umask=$(umask)
	umask 077
	printf '%s' "$TOKEN" >"$TOKEN_FILE"
	umask "$old_umask"

	systemctl daemon-reload
	systemctl enable cockpitd
	restart_daemon "enrolling with the token"

	wait_for_disposition connected || timeout_message

	# The daemon unlinks the token file itself once the credential is on disk.
	clear_enrolment_dropin
	trap - EXIT INT TERM

	log "enrolled. This server is connected to $PLANE."
}

clear_enrolment_dropin() {
	rm -f "$DROPIN"
	rmdir "$DROPIN_DIR" 2>/dev/null || true
	rm -f "$TOKEN_FILE"
	systemctl daemon-reload
}

# An enrolment left half-done by an earlier run otherwise leaves the unit
# permanently starting cockpitd with --token-file pointing at a file the daemon
# has already burned.
clear_stale_enrolment() {
	[ -f "$DROPIN" ] || [ -f "$TOKEN_FILE" ] || return 0

	log "clearing an enrolment token left by an earlier run"
	clear_enrolment_dropin

	# A running daemon still holds the token it was started with, so removing
	# the files is only half of it.
	RESTART_REQUIRED="a spent enrolment token was cleared"
}

# The code lives in the daemon's memory and in /run, so restarting issues a new
# one and invalidates whatever the operator has already pasted into a client.
# Re-running the one-liner to see the code again lands here, so a live code is
# left alone and `cockpitd claim` reprints it.
enrol_with_claim_code() {
	clear_stale_enrolment
	refresh_status

	if restart_if_needed || [ "$(status_field disposition)" != awaiting_claim ]; then
		rc=0
		wait_for_disposition awaiting_claim || rc=$?

		case "$rc" in
		0) ;;
		2)
			log "this server is now connected to $PLANE."

			return 0
			;;
		*) timeout_message ;;
		esac
	else
		log "cockpitd is already waiting to be claimed: showing the code it is offering"
	fi

	# A code can age out between the wait returning and the render, and a whole
	# successful install must not end on that.
	if ! "$BIN" claim </dev/null; then
		log "the claim code could not be shown just now — it may have aged out."
		log "  cockpitd publishes a fresh one within a minute: sudo cockpitd claim"
	fi
}

upgrade() {
	if restart_if_needed; then
		rc=0
		wait_for_disposition connected || rc=$?

		case "$rc" in
		0) ;;
		2)
			die "cockpitd settled on '$(status_field disposition)' rather than connecting.
  $(status_field advice)"
			;;
		*) timeout_message ;;
		esac

		log "upgraded to cockpitd $COCKPITD_VERSION and reconnected to $PLANE."

		return 0
	fi

	refresh_status

	case "$(status_field disposition)" in
	connected) log "cockpitd $COCKPITD_VERSION is installed and connected to $PLANE." ;;
	*) log "cockpitd is '$(status_field disposition)': $(status_field advice)" ;;
	esac
}

main() {
	parse_args "$@"
	validate_args

	preflight_host
	ensure_tools

	resolve_plane
	require_same_plane

	preflight_network
	ensure_docker

	FINGERPRINT_BEFORE=$(fingerprint)

	install_binary
	write_config
	write_unit
	write_uninstall

	FINGERPRINT_AFTER=$(fingerprint)

	refresh_status

	if [ "$(status_field enrolled)" = true ]; then
		[ -z "$TOKEN" ] || log "this server is already enrolled; ignoring the token given on the command line"

		clear_stale_enrolment
		upgrade

		return 0
	fi

	if [ -n "$TOKEN" ]; then
		enrol_with_token
	else
		enrol_with_claim_code
	fi
}

main "$@"
