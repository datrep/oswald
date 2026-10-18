#!/usr/bin/env python3
"""wol_and_probe.py - wake the desk computer and wait for it to answer (v2, 2026-10-03).

WHAT IT DOES
  Sends a Wake-on-LAN magic packet to the desk computer's Ethernet NIC, then polls a TCP port
  until the machine answers. Logs every run to /volume1/logs/wol.log. Exit 0 = awake, 1 = timeout.

WHY v2 (2026-10-03)
  v1 was run for months without ever succeeding at waking anything: TARGET_MAC was the ZeroTier
  VIRTUAL adapter's MAC (it does not exist while Windows is off - a magic packet to it can never
  land) and TARGET_IP pointed at a dead ZeroTier network (10.244.10.3). Both fixed 2026-10-03 and
  validated live. See oswald/temp/remote-access-readiness-2026-10-03.md.

  v2 adds: periodic re-send of the magic packet while waiting (redundancy), a --check probe mode,
  optional Telegram notification via /volume1/scripts/wol_notify.conf (see the .example file -
  nothing is sent unless that conf exists), and configurable mac/ip/port/broadcast/timeout.

USAGE (on the NAS, as admin)
  python3 /volume1/scripts/wol_and_probe.py                 # wake + wait (the normal run)
  python3 /volume1/scripts/wol_and_probe.py --check         # probe only, no magic packet
  python3 /volume1/scripts/wol_and_probe.py --quiet         # log-only (for scheduled tasks)
"""
import argparse
import datetime
import os
import socket
import sys
import time

CONF_FILE = "/volume1/scripts/wol_notify.conf"
LOG_FILE = "/volume1/logs/wol.log"


def log(msg, quiet=False):
    line = "{} - {}".format(datetime.datetime.now(), msg)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except OSError as e:
        print("WARN: cannot write {}: {}".format(LOG_FILE, e))
    if not quiet:
        print(line)


def wake_on_lan(mac, broadcast, port=9):
    mac_bytes = bytes.fromhex(mac.replace(":", "").replace("-", ""))
    packet = b"\xff" * 6 + mac_bytes * 16
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    try:
        s.sendto(packet, (broadcast, port))
    finally:
        s.close()


def port_open(ip, port, timeout=3):
    try:
        with socket.create_connection((ip, port), timeout):
            return True
    except OSError:
        return False


def notify(text):
    """Optional Telegram push. Silence unless wol_notify.conf exists with both fields set."""
    if not os.path.exists(CONF_FILE):
        return
    conf = {}
    try:
        with open(CONF_FILE) as f:
            for raw in f:
                raw = raw.strip()
                if not raw or raw.startswith("#") or "=" not in raw:
                    continue
                k, v = raw.split("=", 1)
                conf[k.strip()] = v.strip()
    except OSError:
        return
    token = conf.get("telegram_bot_token")
    chat = conf.get("telegram_chat_id")
    if not token or not chat:
        return
    try:
        import json
        import urllib.request
        body = json.dumps({"chat_id": chat, "text": text}).encode()
        req = urllib.request.Request(
            "https://api.telegram.org/bot{}/sendMessage".format(token),
            data=body, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:  # noqa: BLE001 - notification must never fail the run
        print("notify failed: {}".format(e))


def parse_args():
    p = argparse.ArgumentParser(description="Wake the desk computer and wait for it to answer.")
    p.add_argument("--mac", default="e8:9c:25:3f:ec:42", help="target NIC MAC (desk Realtek Ethernet)")
    p.add_argument("--ip", default="172.22.160.3", help="address to probe (desk ZeroTier IP)")
    p.add_argument("--port", type=int, default=22, help="port that proves the machine is up (SSH)")
    p.add_argument("--broadcast", default="192.168.1.255", help="LAN broadcast for the magic packet")
    p.add_argument("--timeout", type=int, default=150, help="seconds to wait for the port")
    p.add_argument("--resend-every", type=int, default=15,
                   help="re-send the magic packet every N seconds while waiting (0 = send once)")
    p.add_argument("--check", action="store_true", help="probe only - never send a magic packet")
    p.add_argument("--quiet", action="store_true", help="only write the log file (for scheduled tasks)")
    return p.parse_args()


def main():
    a = parse_args()
    started = time.time()

    if a.check:
        up = port_open(a.ip, a.port, 5)
        log("Probe: target is {} ({}:{})".format("UP" if up else "DOWN", a.ip, a.port), a.quiet)
        notify("desk computer is {} ({}:{})".format("UP" if up else "DOWN", a.ip, a.port))
        return 0 if up else 1

    log("Sending Wake-on-LAN packet", a.quiet)
    wake_on_lan(a.mac, a.broadcast)
    log("Waiting for {}:{}".format(a.ip, a.port), a.quiet)

    last_send = time.time()
    while time.time() - started < a.timeout:
        if port_open(a.ip, a.port):
            took = int(time.time() - started)
            log("Target is awake and reachable ({}s)".format(took), a.quiet)
            notify("desk computer is AWAKE - {}:{} answers ({}s after wake)".format(a.ip, a.port, took))
            return 0
        if a.resend_every and (time.time() - last_send) >= a.resend_every:
            wake_on_lan(a.mac, a.broadcast)
            last_send = time.time()
        time.sleep(3)

    log("Timeout waiting for target", a.quiet)
    notify("desk computer did NOT wake within {}s - check the NAS log / try again".format(a.timeout))
    return 1


if __name__ == "__main__":
    sys.exit(main())
