#!/usr/bin/env bash
#
# Linux stub - firmware updater for the same Dell DDR3 fleet (390/7010/7020).
# Engine: fwupd (LVFS) for BIOS/SSD/NIC + intel-microcode package for CPU ucode.
#
# Usage:  sudo ./update-firmware.sh [bios|microcode|ssd|nic|all|discover]
# No argument = interactive menu (lets you pick which "latest spec" to run).
# 'discover' enumerates board/GPU/NIC/disk - fwupd/LVFS already covers consumer boards.
#
set -euo pipefail

COMPONENT="${1:-menu}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a firmware-update.log; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)."

model=$(sudo dmidecode -s system-version 2>/dev/null || echo unknown)
cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | xargs)
bios=$(sudo dmidecode -s bios-version 2>/dev/null || echo unknown)
log "Machine : $model"
log "CPU     : $cpu"
log "BIOS    : $bios"

require_fwupd() { command -v fwupdmgr >/dev/null 2>&1 || die "fwupd not installed (apt install fwupd)."; }

menu() {
    echo
    echo "================================================"
    echo "  Dell DDR3 fleet - firmware updater (Linux)"
    echo "================================================"
    echo "  [1] BIOS/UEFI firmware"
    echo "  [2] Intel CPU microcode"
    echo "  [3] SSD firmware"
    echo "  [4] NIC firmware"
    echo "  [5] EVERYTHING"
    echo "  [6] Discover hardware (fwupd/lspci/lsblk)"
    echo "  [q] Quit"
    echo
    read -r -p "Which updates do you want to run? " ans
    case "$ans" in
        1) echo bios ;;
        2) echo microcode ;;
        3) echo ssd ;;
        4) echo nic ;;
        5) echo all ;;
        6) echo discover ;;
        q) exit 0 ;;
        *) echo invalid ;;
    esac
}

do_bios() {
    require_fwupd
    log ">>> BIOS/UEFI via fwupd (LVFS)"
    fwupdmgr refresh --force
    fwupdmgr get-updates || true
    fwupdmgr update
}

do_microcode() {
    log ">>> Intel CPU microcode"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        apt-get install -y intel-microcode
    else
        log "Unsupported package manager - install 'intel-microcode' manually."
    fi
    if [ -w /sys/devices/system/cpu/microcode/reload ]; then
        echo 1 > /sys/devices/system/cpu/microcode/reload
        log "microcode reloaded."
    fi
}

do_ssd() {
    require_fwupd
    log ">>> SSD firmware via fwupd (LVFS)"
    fwupdmgr get-devices | grep -iE 'ssd|nvme|solid' || log "no SSD device reported by fwupd"
    fwupdmgr update
}

do_nic() {
    require_fwupd
    log ">>> NIC firmware via fwupd (LVFS)"
    fwupdmgr get-devices | grep -iE 'network|ethernet|wifi|nic' || log "no NIC device reported by fwupd"
    fwupdmgr update
}

do_discover() {
    log ">>> Hardware discovery (auto, no manual list)"
    fwupdmgr get-devices || true
    log "--- GPU / NIC / storage controllers (lspci) ---"
    (lspci -nnk 2>/dev/null | grep -iE 'vga|3d|display|network|ethernet|wireless|nvme|sata|ahci') || true
    log "--- Disks (lsblk) ---"
    (lsblk -d -o NAME,MODEL,REV,TRAN 2>/dev/null) || true
}

run() {
    local target="$1"
    case "$target" in
        bios)      do_bios ;;
        microcode) do_microcode ;;
        ssd)       do_ssd ;;
        nic)       do_nic ;;
        discover)  do_discover ;;
        all)       do_bios; do_microcode; do_ssd; do_nic ;;
        *)         die "unknown component: $target" ;;
    esac
}

if [ "$COMPONENT" = "menu" ]; then
    COMPONENT=$(menu)
    [ "$COMPONENT" = "invalid" ] && { echo "Invalid choice."; exit 1; }
fi

run "$COMPONENT"
log "Done."
