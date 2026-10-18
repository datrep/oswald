# DDR3 fleet — firmware updater

Menu-driven firmware updater for the three Dell OptiPlex DDR3-generation machines:

| Model          | Chipset | Socket  | Arch          | CPUID    | RAM   | Dell Command Update |
|----------------|---------|---------|---------------|----------|-------|---------------------|
| OptiPlex 390   | H61     | LGA1155 | Sandy Bridge  | `0x206A7`| DDR3  | No (offline .exe)   |
| OptiPlex 7010  | Q77     | LGA1155 | Ivy Bridge    | `0x306A9`| DDR3  | Yes                 |
| OptiPlex 7020  | Q87     | LGA1150 | Haswell       | `0x306C3`| DDR3  | Yes                 |

The menu lets you pick **which** "latest spec" to apply, instead of blindly flashing
everything: BIOS/UEFI, CPU microcode, SSD firmware, NIC firmware, or all.

## What each component actually means

- **BIOS/UEFI firmware** — the motherboard firmware from Dell. This is the big one and
  also carries the newest Intel microcode Dell validated for that board.
- **Intel CPU microcode** — the CPU-internal patches (Spectre/Meltdown/MDS mitigations,
  stability fixes). Delivered two ways: inside the BIOS **and** via Windows servicing /
  the `intel-microcode` package on Linux. There is no standalone Intel microcode
  installer for Windows.
- **SSD firmware** — vendor-specific (Samsung/Crucial/Intel/WD/Dell). Dell-branded
  drives are covered by Dell Command Update; other vendors need their own tool.
- **NIC firmware** — Intel/Realtek/Broadcom network card firmware, mostly via Dell
  Command Update or Intel `nvmupdate`.

## Windows 10 LTSC — `Update-Firmware.ps1`

```powershell
# From an elevated PowerShell:
powershell -ExecutionPolicy Bypass -File .\Update-Firmware.ps1
```

- Requires **Administrator** (it refuses otherwise).
- It detects the model from SMBIOS. Known Dell models (390/7010/7020) can flash;
  unknown models skip the offline `.exe` flash but still try Dell Command Update,
  which resolves the correct BIOS by service tag (wrong-package protection).
- Primary engine is **Dell Command | Update** (`dcu-cli.exe`), which resolves the real
  latest versions from Dell for the exact machine. Install it once per machine:
  <https://www.dell.com/support/kbdoc/000177325>
- The menu is the selector for *which* updates to run.

### Offline / USB-stick mode (no internet on the PC)

Drop packages in these folders next to the script and they'll be used:

| Folder       | Contents                                | How it's applied                        |
|--------------|-----------------------------------------|------------------------------------------|
| `.\bios\`    | Dell BIOS `.exe` for the exact model    | silent flash `/s /r` (log next to script)|
| `.\microcode\` | microcode servicing `.msu`            | `wusa /quiet /norestart`                 |
| `.\ssd\`     | vendor SSD tool `.exe/.bat`             | run as-is                                |
| `.\nic\`     | vendor NIC tool `.exe/.bat`             | run as-is                                |

If a package's filename matches the detected model name, it is preferred over others.

### Skip the menu (scripted / batch use)

```powershell
.\Update-Firmware.ps1 -Component bios       # BIOS only
.\Update-Firmware.ps1 -Component microcode  # microcode only
.\Update-Firmware.ps1 -Component all        # everything
.\Update-Firmware.ps1 -Component consumer   # discover + patch ANY machine (Windows Update)
.\Update-Firmware.ps1 -Component consumer -DiscoverOnly   # inventory only, no changes
.\Update-Firmware.ps1 -Component all -Reboot
```

## Linux stub — `update-firmware.sh`

```bash
sudo ./update-firmware.sh            # interactive menu
sudo ./update-firmware.sh all        # or: bios | microcode | ssd | nic | all
```

- BIOS/SSD/NIC via `fwupd` (LVFS) — `apt install fwupd` if missing.
- Microcode via the `intel-microcode` package + reload into the running kernel.

## Consumer / non-OEM machines (auto-discover + patch)

Menu option **[6]** (or `-Component consumer`) handles custom builds and non-Dell
machines **without any manual file list**:

1. **Discover** — enumerates the board, CPU, GPU(s), disks, NICs and their current
   driver/firmware versions straight from CIM/WMI, and writes a generated
   `inventory-<manufacturer>.json` snapshot next to the script.
2. **Patch** — routes everything through **Windows Update / PnP**, the universal,
   zero-maintenance source for consumer drivers and UEFI firmware capsules:
   - If the `PSWindowsUpdate` module is installed, it installs the *Drivers*
     category headlessly (`Install-Module PSWindowsUpdate -Scope CurrentUser -Force`).
   - Otherwise it falls back to `pnputil /scan-devices` + `UsoClient StartScan`.
3. **Report** — lists which vendor tools (Intel DSA, NVIDIA, AMD, Samsung Magician,
   etc.) are *already installed*, so you know what else can be scripted. Nothing is
   downloaded from a hand-maintained list.

`-DiscoverOnly` runs just step 1 (safe inventory — no changes).

On **Linux**, consumer machines are already fully covered: `fwupd`/LVFS is exactly
the "no list" mechanism, and menu option `[6] discover` prints the same inventory
via `fwupd`, `lspci`, and `lsblk`.

## Safety notes

- BIOS flashing is **model-specific** — never cross-flash between 390/7010/7020.
- Keep AC power stable during any firmware flash; an interrupted flash can brick a board.
- "Latest" versions are resolved at runtime by Dell Command Update / LVFS, so the
  script never hardcodes a possibly-stale version number. `models.json` only stores
  stable identification facts (CPUID, chipset, socket).
