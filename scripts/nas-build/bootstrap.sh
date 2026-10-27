#!/usr/bin/env bash
# bootstrap.sh — Debian 13 (Trixie) minimal → OpenMediaVault 8, baseline only.
# Run as root on the freshly installed Debian, BEFORE configuring anything in the OMV UI.
#
#   scp bootstrap.sh root@<nas-ip>:/root/ && ssh root@<nas-ip> 'bash /root/bootstrap.sh'
#
# Deliberately conservative: it installs and sets the OS baseline, and stops.
# Shares, RAID and services are done in nas-setup.sh + the OMV UI.

set -euo pipefail

HOSTNAME_WANT="nas"
TZ_WANT="Asia/Singapore"
OMV_INSTALLER="https://github.com/OpenMediaVault-Plugin-Developers/installScript/raw/master/install"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."

# ---------------------------------------------------------------- preflight
log "Preflight"

[[ -f /etc/os-release ]] || die "Not a Debian-family system."
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "Expected Debian, found '${ID:-unknown}'."
[[ "${VERSION_ID:-}" == "13" ]] || die "Expected Debian 13 (Trixie), found '${VERSION_ID:-unknown}'. OMV 8 is built for Trixie."

ARCH=$(dpkg --print-architecture)
[[ "$ARCH" == "amd64" ]] || die "Expected amd64, found $ARCH."

# OMV wants a minimal install; these conflict with it.
# Skip this check when OMV is already present - the OMV ISO installs nginx and
# php-fpm itself, and flagging them would refuse a perfectly good install.
if dpkg -s openmediavault >/dev/null 2>&1; then
  log "openmediavault already present - skipping minimal-base check"
else
  CONFLICTS=(postfix exim4 bind9 nginx php-fpm)
  for p in "${CONFLICTS[@]}"; do
    if dpkg -s "$p" >/dev/null 2>&1; then
      die "$p is installed and conflicts with OMV. Reinstall Debian minimal (no task selections)."
    fi
  done
fi

ping -c1 -W3 deb.debian.org >/dev/null 2>&1 || die "No network."

log "Debian ${VERSION_ID} ${ARCH} — OK"

# ---------------------------------------------------------------- baseline
log "Hostname → ${HOSTNAME_WANT}"
hostnamectl set-hostname "$HOSTNAME_WANT"
grep -q "127.0.1.1" /etc/hosts || echo "127.0.1.1 ${HOSTNAME_WANT}" >> /etc/hosts

log "Timezone → ${TZ_WANT}"
timedatectl set-timezone "$TZ_WANT"
systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true

log "Updating package lists"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# OMV manages its own upgrades. A blanket apt upgrade behind its back can leave
# the config database out of step with the installed packages, so let the
# OMV Update Management page do it when OMV is present.
if dpkg -s openmediavault >/dev/null 2>&1; then
  log "OMV present - leaving the package upgrade to OMV Update Management"
else
  apt-get -y -qq upgrade
fi

log "Installing baseline packages"
# smartmontools → SMART for the OMV UI
# btrfs-progs   → Btrfs RAID1 + snapshots
# mdadm         → only if md RAID is ever needed
apt-get -y -qq install --no-install-recommends \
  curl wget gnupg ca-certificates \
  smartmontools btrfs-progs mdadm \
  hdparm lm-sensors pciutils usbutils \
  nano htop rsync

log "Enabling SMART monitoring"
sed -i 's/^#*smartd_opts=.*/smartd_opts="--interval=1800"/' /etc/default/smartmontools 2>/dev/null || true
systemctl enable --now smartd >/dev/null 2>&1 || true

# ---------------------------------------------------------------- OMV
log "Installing OpenMediaVault 8 (this takes a while)"
if dpkg -s openmediavault >/dev/null 2>&1; then
  log "openmediavault already installed — skipping"
else
  curl -fsSL "$OMV_INSTALLER" -o /root/omv-install.sh
  bash /root/omv-install.sh
fi

# ---------------------------------------------------------------- verify
log "Post-install check"
for svc in openmediavault-engined nginx smartd; do
  if systemctl list-unit-files "$svc.service" >/dev/null 2>&1; then
    printf '  %-28s %s\n' "$svc" "$(systemctl is-active "$svc" 2>/dev/null || echo n/a)"
  fi
done

IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
cat <<EOF

────────────────────────────────────────────────────────────
 OMV 8 installed. Networking left on DHCP by design —
 set a DHCP reservation on the CUSTOMER's router, do not
 bake a static IP from the build LAN.

   Web UI : https://${IP:-<nas-ip>}
   Login  : admin / openmediavault        <-- CHANGE THIS NOW

 Next:
   1. Log in and change the admin password.
   2. Work the checklist in nas-setup.sh.
   3. verify-nas.sh before handover.
────────────────────────────────────────────────────────────
EOF
