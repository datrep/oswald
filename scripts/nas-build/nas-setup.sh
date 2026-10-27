#!/usr/bin/env bash
# nas-setup.sh — post-install configuration for the OMV 8 build.
#
# Run as root after bootstrap.sh and after logging into the web UI once.
#
# What this does AUTOMATICALLY: OS-level things that are deterministic.
# What it deliberately does NOT do: OMV's own config, which lives in a salt-managed
# database whose RPC parameter shapes differ between OMV majors. Those steps are
# printed as a checklist instead of guessed at — ~2 minutes in the UI.
#
# A script that half-applies a config is worse than a checklist.

set -euo pipefail
log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
dpkg -s openmediavault >/dev/null 2>&1 || { echo "OMV not installed. Run bootstrap.sh first." >&2; exit 1; }

DATA_MOUNT="${DATA_MOUNT:-/srv/data}"
SHARE_DIR="${SHARE_DIR:-${DATA_MOUNT}/share}"

# --------------------------------------------------------- OS level
log "Directories"
mkdir -p "$DATA_MOUNT" "$SHARE_DIR"
chmod 0775 "$SHARE_DIR"

log "Docker + Compose (for the optional app stack)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  log "docker already present"
fi

log "Firewall posture"
if systemctl is-active --quiet ufw; then
  ufw status | head -20
else
  echo "  ufw not active — OMV manages its own rules."
  echo "  NEVER expose SMB (139/445) to the WAN."
fi

# --------------------------------------------------------- report
cat <<EOF

────────────────────────────────────────────────────────────
 OS-level setup done. Now the OMV checklist (UI, ~2 min):

 1. SYSTEM > General
    Hostname already set. Confirm timezone Asia/Singapore.

 2. STORAGE > Disks
    Confirm every disk detected. Note serials for the record.

 3. STORAGE > File Systems
    Create Btrfs on the two data disks with profile "raid1".
    OMV labels this a Btrfs profile — choose raid1, not single.

 4. STORAGE > Shared Folders
    One folder named "share" on the RAID1 filesystem.

 5. SERVICES > SMB/CIFS
    Enable. Workgroup WORKGROUP.
    Share with the customer's user account, read/write.

 6. SERVICES > SMART
    Enable monitoring. Confirm both data disks appear.

 7. SYSTEM > Scheduled Jobs
    Snapshot job on the RAID1 filesystem, daily 02:00, keep 14.

 8. USERS
    admin — change from "openmediavault" NOW.
    user  — customer's account. Set a password, hand over
            separately, tell them to change it.

 9. NETWORK
    Leave DHCP. Set the reservation on the CUSTOMER's router,
    not here.

 Then: verify-nas.sh
────────────────────────────────────────────────────────────
EOF
