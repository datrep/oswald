#!/usr/bin/env bash
# verify-nas.sh — pre-handover evidence capture.
# Run as root on the NAS. Prints a block you can paste into the customer record.
#
# This is the software baseline that makes the software-exclusion clause
# enforceable. Keep the output with the invoice.

set -uo pipefail
line() { printf '%s\n' "────────────────────────────────────────────────────────────"; }

echo
line
echo " NAS build record — $(date -Iseconds)"
line

echo
echo "## Identity"
printf '  hostname      : %s\n' "$(hostname)"
printf '  os            : %s\n' "$(sed -n 's/^PRETTY_NAME="\(.*\)"/\1/p' /etc/os-release 2>/dev/null)"
printf '  omv           : %s\n' "$(dpkg-query -W -f='${Version}' openmediavault 2>/dev/null || echo 'not installed')"
printf '  kernel        : %s\n' "$(uname -r)"
printf '  firmware      : %s\n' "$([ -d /sys/firmware/efi ] && echo UEFI || echo LEGACY)"
printf '  ip            : %s\n' "$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
printf '  mac           : %s\n' "$(cat /sys/class/net/$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $5; exit}')/address 2>/dev/null)"

echo
echo "## CPU / RAM"
printf '  cpu           : %s\n' "$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo)"
printf '  cores         : %s\n' "$(nproc)"
printf '  memory        : %s\n' "$(awk '/MemTotal/{printf "%.1f GB\n", $2/1048576}' /proc/meminfo)"

echo
echo "## SATA controllers"
if command -v lspci >/dev/null 2>&1; then lspci | grep -iE 'sata|ahci' | sed 's/^/  /'; else echo '  (lspci unavailable)'; fi
echo "  link speeds:"
dmesg 2>/dev/null | grep -oE 'ata[0-9]+: SATA link up [0-9.]+ Gbps' | sed 's/^/    /' | sort -u

echo
echo "## Disks"
lsblk -d -o NAME,SIZE,MODEL,SERIAL 2>/dev/null | sed 's/^/  /'

echo
echo "## SMART health"
for d in /dev/sd?; do
  [[ -b "$d" ]] || continue
  h=$(smartctl -H "$d" 2>/dev/null | awk -F': ' '/overall-health/{print $2}' | tr -d '\r')
  h=${h:-VERDICT UNAVAILABLE}
  hours=$(smartctl -A "$d" 2>/dev/null | awk '/Power_On_Hours/{print $10; exit}')
  realloc=$(smartctl -A "$d" 2>/dev/null | awk '/Reallocated_Sector_Ct/{print $10; exit}')
  printf '  %-9s %-22s %-22s hours=%-8s realloc=%s\n' \
    "$(basename "$d")" "$(smartctl -i "$d" 2>/dev/null | awk -F': ' '/Device Model/{print $2; exit}')" \
    "$h" "${hours:-?}" "${realloc:-?}"
done

echo
echo "## Filesystems"
findmnt -rno TARGET,FSTYPE,SIZE,USED,USE% 2>/dev/null | grep -vE '^/(proc|sys|dev|run)' | sed 's/^/  /'

echo
echo "## Shares"
if command -v smbstatus >/dev/null 2>&1; then
  smbstatus --shares 2>/dev/null | sed 's/^/  /' || echo "  (smbstatus unavailable)"
else
  echo "  samba not installed"
fi

echo
echo "## Services"
for s in openmediavault-engined nginx smbd smartd docker; do
  printf '  %-24s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null | head -n1)"
done

echo
line
echo " Keep this output with the invoice. It is the baseline that"
echo " 'outside the delivered configuration' is measured against."
line
echo
