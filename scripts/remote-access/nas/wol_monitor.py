#!/usr/bin/env python3
"""wol_monitor.py - one-shot reachability check designed for a SCHEDULED TASK (v1, 2026-10-03).

PURPOSE
  The original design was "the NAS periodically pings the target machine; it is logged to a file
  and the user is notified". wol_and_probe.py covers the wake flow; THIS script covers the
  background record: it runs, probes the desk computer once, and appends a line ONLY when the
  state CHANGES (UP -> DOWN or DOWN -> UP) - so the log stays a timeline of events, not noise.

SUGGESTED SCHEDULE (ASUSTOR ADM -> Task Scheduler, every 5 minutes):
  python3 /volume1/scripts/wol_monitor.py --quiet
Logs: /volume1/logs/monitor.log   -   State breadcrumb: /volume1/logs/.monitor.state
Optional Telegram pushes on transitions via wol_notify.conf (same file as wol_and_probe.py).
Exit code: 0 = target up, 1 = target down (scheduled tasks can surface this).
"""
import argparse
import datetime
import os
import socket
import sys

LOG_FILE = "/volume1/logs/monitor.log"
STATE_FILE = "/volume1/logs/.monitor.state"
CONF_FILE = "/volume1/scripts/wol_notify.conf"


def port_open(ip, port, timeout=3):
    try:
        with socket.create_connection((ip, port), timeout):
            return True
    except OSError:
        return False


def notify(text):
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
    except Exception:
        pass


def main():
    p = argparse.ArgumentParser(description="Transition-logged reachability check (for cron).")
    p.add_argument("--ip", default="172.22.160.3")
    p.add_argument("--port", type=int, default=22)
    p.add_argument("--quiet", action="store_true")
    a = p.parse_args()

    up = port_open(a.ip, a.port)
    now_state = "UP" if up else "DOWN"

    prev = None
    try:
        with open(STATE_FILE) as f:
            prev = f.read().strip() or None
    except OSError:
        prev = None

    if prev != now_state:
        line = "{} - {} ({}:{})".format(datetime.datetime.now(), now_state, a.ip, a.port)
        try:
            with open(LOG_FILE, "a") as f:
                f.write(line + "\n")
        except OSError as e:
            print("WARN: cannot write {}: {}".format(LOG_FILE, e))
        if not a.quiet:
            print(line)
        notify("desk computer is now {}".format(now_state))
        try:
            with open(STATE_FILE, "w") as f:
                f.write(now_state + "\n")
        except OSError:
            pass

    return 0 if up else 1


if __name__ == "__main__":
    sys.exit(main())
