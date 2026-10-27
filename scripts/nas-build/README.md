# NAS build — scripts

Companion to [nas-build-runbook.md](../../legal/standards/nas-build-runbook.md).

**Order of work**

| # | Step | Where |
|---|---|---|
| 1 | ISO → USB with **Rufus, MBR/legacy**. ⚠️ Test it boots on this board before wiping anything | your desktop |
| 2 | Install **Debian 13 minimal** — no task selections, no desktop | on the NAS, monitor + keyboard |
| 3 | `bootstrap.sh` — OMV 8 + OS baseline | over SSH |
| 4 | `nas-setup.sh` — OS prep, then work the printed OMV checklist in the UI | over SSH |
| 5 | `verify-nas.sh` — capture the build record | over SSH |
| 6 | Image the SSD → recovery kit | offline |

```bash
scp bootstrap.sh nas-setup.sh verify-nas.sh root@<nas-ip>:/root/
ssh root@<nas-ip> 'bash /root/bootstrap.sh'
```

**Why the split.** `bootstrap.sh` is deterministic and safe to re-run. `nas-setup.sh` stops at OMV's own config on purpose: that lives in a salt-managed database whose RPC parameter shapes move between OMV majors, and a script that half-applies it is worse than a two-minute checklist.

**Networking is deliberately DHCP.** You are building on your LAN and delivering to the customer's. A static IP set here will be wrong there, and he cannot fix it. Set the **DHCP reservation on his router** at handover. Record the MAC from `verify-nas.sh`.

**Recovery kit.** Bootable Clonezilla + the SSD image, plus a pre-cloned spare SSD.
- ⚠️ It restores the **system**, not his photos.
- ⚠️ **RAID membership is not in the image** — mdadm/Btrfs array metadata lives on the disks. Re-attach the data disks, then import the array in OMV.
