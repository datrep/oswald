# remote-access — laptop kit

Verified end-to-end **2026-10-03** (full measurements: `temp/remote-access-readiness-2026-10-03.md`
on the desk machine). This folder is the portable copy — drop it on the laptop.

## The chain
```
laptop --ZeroTier--> NAS (172.22.160.4) --magic packet--> desk computer (172.22.160.3)
then connect: SSH :22 (Bitvise server) · RDP via a Bitvise tunnel
```

## Values (verified 2026-10-03)
| thing | value |
|---|---|
| ZeroTier network | `b15644912eae9aa3` |
| desk computer (ZeroTier / LAN) | `172.22.160.3` / `192.168.1.26` |
| NAS (ZeroTier / LAN) | `172.22.160.4` / `192.168.1.12` |
| desk computer wake MAC | `e8:9c:25:3f:ec:42` (Realtek Ethernet; WoL armed, fast startup off) |
| NAS SSH | `admin@172.22.160.4:22` — password = NAS admin (desk root `.env`) |
| NAS SSH host-key fingerprint | `SHA256:yZ9anO/CuVKDsZguNYpYAnHZmA1ciODbVbrOSi9l9kM` |
| wake script (on NAS) | `/volume1/scripts/wol_and_probe.py` (fixed 2026-10-03; backup `.bak-2026-10-03`) |
| wake log (on NAS) | `/volume1/logs/wol.log` |
| NAS GUI | `http://172.22.160.4:8000/portal/` (LAN: `http://192.168.1.12:8000/portal/`) |
| desk fileserver / sync | `http://172.22.160.3:8080` · `https://172.22.160.3:8090` |

## Rebuild steps (fresh Windows laptop)
1. **ZeroTier** — run `laptop-rebuild.ps1` **as Administrator**. It installs ZeroTier if missing,
   joins the network, then waits while you **authorize the printed NODE ID in the ZeroTier
   controller** (members list), and finally runs the connectivity tests.
2. **Bitvise SSH Client** (manual install).
   - Profile: host `172.22.160.3`, port 22, the computer's SSH credentials.
   - RDP via tunnel: port-forward `local 3389 → target 127.0.0.1:3389`, then `mstsc /v:127.0.0.1:3389`.
3. **Wake the computer** — run `wake-computer.ps1` (prompts the NAS password once; waits for
   SSH to answer; prints when the computer is up).

## NAS side (v2, deployed 2026-10-03)
The repo copy of the NAS scripts is `nas/` in this folder; on the NAS they live in `/volume1/scripts/`.

| file | purpose |
|---|---|
| `wol_and_probe.py` | the wake trigger. Flags: `--check` (probe only) · `--quiet` (log-only, for scheduled tasks) · `--timeout N` · `--resend-every N` (default 15 s — re-sends the magic packet while waiting) · `--mac/--ip/--port/--broadcast` overrides |
| `wol_monitor.py` | transition-logged reachability check — appends UP/DOWN lines to `/volume1/logs/monitor.log` only when the state CHANGES. **INSTALLED 2026-10-03** as a system cron job, every 5 min: `/usr/builtin/etc/crontabs/admin` → `*/5 * * * * /usr/local/bin/python3 /volume1/scripts/wol_monitor.py --quiet >/volume1/logs/monitor-cron.out 2>&1` (first fire 19:45 SGT confirmed) |
| `wol_notify.conf.example` | template for `wol_notify.conf` (chmod 600). **ENABLED 2026-10-03** — the real file exists on the NAS with the desk bot token + chat id; wake results and monitor transitions push to Telegram (test ping sent 19:42 SGT) |

Logs: `/volume1/logs/wol.log` (every wake run) · `/volume1/logs/monitor.log` (transitions only) · `/volume1/logs/monitor-cron.out` (cron stdout, empty = healthy).

## Gotchas
- The wake check uses **TCP :22** (SSH comes up early in boot), max 150 s on the NAS side;
  the packet is re-sent every 15 s while waiting. The NAS's own `ping` needs root — the script
  deliberately uses TCP sockets; do not "fix" it back to ICMP.
- **Direct RDP** to `172.22.160.3:3389` is blocked by the computer's firewall (both LAN and
  ZeroTier; RDP itself listens on `0.0.0.0:3389`). The **tunnel path is the supported one**.
  To open direct RDP later, run this once in an **admin** PowerShell on the computer:
  `netsh advfirewall firewall add rule name=OSWALD-RDP-ZT-LAN dir=in action=allow protocol=TCP localport=3389 remoteip=172.22.160.0/24,192.168.1.0/24`
- **Real wake-from-off test: ✅ PASSED 2026-10-03** — with the machine untouched and fully off
  (power-off ≈20:45:55), the **20:50:04 magic packet woke it** (kernel up 20:50:24 ≈19 s later).
  Lesson: send packets **repeatedly for ≥5 min** (the NIC's first minutes after a shutdown are not
  perfectly deterministic — a single early packet can be missed) and allow **60–90 s after the last
  packet before concluding failure** (boot itself takes ~40–60 s; one probe timeout = try again).
  Full forensics: `temp/remote-access-readiness-2026-10-03.md` (wake-test verdict sections).
