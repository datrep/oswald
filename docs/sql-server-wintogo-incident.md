# Incident Report: SQL Server Services Fail to Start on Windows To Go

**Status:** Resolved (2026-08-16)
**Affected:** `MSSQL$SQLEXPRESS` (named instance) and, initially, `MSSQLSERVER` (default)
**Machine:** HP Pavilion Laptop 14-dv1xxx, Windows 10 Enterprise LTSC 2021 (19044), running from an external WD 500 GB USB SSD as a **Windows To Go** workspace
**Fix scripts:** `scripts/fix-sqlexpress-cv.ps1`, `scripts/fix-sqlexpress-netlib.ps1` (both idempotent) · verify with `scripts/check-sql-health.ps1`

---

## 1. Problem statement

SQL Server services on this machine would start **once right after installation**, then fail on every subsequent start with:

```
SQL Server could not find the specified named instance (SQLEXPRESS) - error 2
```

(For the default instance: `could not find the default instance (MSSQLSERVER) - error 2`)

- SCM logged `7034 — The service terminated unexpectedly` (repeated up to 13 times).
- `sqlservr.exe` exited immediately with code **1046** (and, in the classic case, `1067`), **before writing anything to its ERRORLOG**.
- This reproduced across **SQL Server 2025 and 2022**, **named and default instances**, and **two different drives**.
- The bootstrap (`scripts/bootstrap-fresh-machine.ps1`) would detect the instance, self-heal registry keys, but still fail to start the service.

The machine's SQL Server was effectively unusable, and the symptoms suggested either a corrupt OS image or a broken SQL installation.

---

## 2. Environment

| Item | Value |
|---|---|
| OS | Windows 10 Enterprise LTSC 2021 (build 19044) |
| Boot mode | **Windows To Go** on external USB SSD (`PortableOperatingSystem=1`) |
| CPU / RAM | 8 logical processors / 16 GB |
| SQL Server 2022 | Express 16.0.1000.6 — two instances: `SQLEXPRESS` (named), `MSSQLSERVER` (default) |
| SQL Server 2025 | Express 17.0.1000.7 — previously installed, later removed (incompatible with 19044; needs `GetNumaNodeProcessorMask2`, Win11+ only) |
| Node.js | v24.19.0 |
| Oswald | Dashboard on 8080/8443, fileserver on 8090/8091, `DB_Oswald` in LocalDB (`MSSQLLocalDB`) via `mssql/msnodesqlv8` |

---

## 3. Symptoms

1. **Service start fails** with `could not find the specified [named/default] instance - error 2` (SCM exit `1067`, or manual-run exit `1046`).
2. **No ERRORLOG entry is written** for the failed start — `sqlservr.exe` dies during early instance/configuration resolution, before it opens its error log.
3. **SQLBrowser** repeatedly logs: `The SQL configuration for SQL is inaccessible or invalid` (for both instances).
4. **`UpdateUptimeRegKey: Access is denied`** appears in the ERRORLOG on every clean shutdown — the service account cannot write its own registry key.
5. Every fresh install ran **once** successfully, then failed on all later restarts.

---

## 4. Investigation — what was ruled out

| Hypothesis | Result |
|---|---|
| Bootstrap registry changes (TCP/Named Pipes/mixed-mode) | ❌ **Ruled out** — reverting every change (experiment protocol) did not help. |
| Corrupt `sqlservr.exe` binaries | ❌ **Ruled out** — SHA-256 of `sqlservr.exe`, `sqlos.dll`, `sqllang.dll` are **identical** between the working default instance and the failing named instance. |
| Missing VC++ runtime | ❌ **Ruled out** — VC++ 2015–2022 x64 present (v14.51.36247), DLLs exist, no SideBySide events. |
| Broken ACLs on the SQL registry hive | ⚠️ **Partially responsible** — the SQL service accounts (`NT SERVICE\MSSQL$SQLEXPRESS`, etc.) had **no explicit rights** on the SQL registry keys (only `BUILTIN\Users`/`Administrators`/`SYSTEM`). **Fixing the ACLs alone was not sufficient**, but it was necessary groundwork. |
| Missing instance-name mapping / Parameters | ⚠️ Present and correct in both 64-bit and WOW6432Node hives — not the (only) cause. |
| Ghost-Optimizer / a boot-time "registry cleaner" | ❓ Suspected (it ran on 08-06 and matches the ACL/key-stripping pattern), but no scheduled task or startup entry was found. Recurrence investigation ongoing. |
| OS image itself is corrupt / needs reinstall | ❌ **Ruled out by the fix** — a normal OS reinstall was planned, but was not needed. |

---

## 5. Root cause

The `SQLEXPRESS` instance's **registry configuration was incomplete**. Two specific pieces were missing, and `sqlservr.exe` failed at each in turn:

1. **`HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL16.SQLEXPRESS\MSSQLServer\CurrentVersion`** — missing.
   - `sqlservr` needs this key to identify/validate the instance.
   - Failure mode: `OpenKey ... CurrentVersion → 0xC0000034 (STATUS_OBJECT_NAME_NOT_FOUND)`, then exit code `1046`.
   - The working default instance **has** this key (`CurrentVersion = 16.0.1000.6`).

2. **`MSSQL16.SQLEXPRESS\MSSQLServer\SuperSocketNetLib`** — missing several subkeys/values:
   - `Np\PipeName` — **missing** (needed to create `\\.\pipe\MSSQL$SQLEXPRESS\sql\query`).
   - `Sm` (Shared Memory), `AdminConnection\Tcp`, `Tcp\IP1..IP6`, `Via` — missing.
   - Failure mode after fixing #1: `TDSSNIClient initialization failed ... Error starting Named Pipes support. The system cannot find the file specified` (events 17182 / 17826 / 17120).

The same "incomplete registry" pattern explains the original `could not find the specified named instance - error 2`: the instance lacked the registry entries it needs to resolve its own identity at startup. The default instance (`MSSQLSERVER`) worked throughout because its registry was intact.

**Why it appeared to "work once then break":** the installer writes a working config and starts the engine during setup, but the registry state on this Windows To Go image was incomplete/fragile (and, in one case, a recreated key was later found missing again — see §8). The engine itself and all binaries were always healthy.

---

## 6. How it was diagnosed (the method, worth reusing)

Silent `sqlservr` startup failures produce **no ERRORLOG** and often **no event-log detail**, so the standard logs are useless. The winning approach was a **kernel ETW trace** (built into Windows — no extra tools):

1. Capture **registry + file** operations during the failed start:

   ```powershell
   # logman only accepts ONE -p per session; run registry and file traces separately
   logman start regtrace -p "Microsoft-Windows-Kernel-Registry" -o regtrace.etl -ets
   # ... trigger the failing sqlservr -sSQLEXPRESS ...
   logman stop regtrace -ets

   tracerpt regtrace.etl -o regtrace-trace.csv -of CSV
   ```

2. In the CSV, find the PID that touches the SQL registry (`Instance Names\SQL`, `MSSQL16.SQLEXPRESS`):

   ```powershell
   Select-String -Path regtrace-trace.csv -Pattern 'Microsoft SQL Server' | ...   # isolate PID 0x2398
   ```

3. Dump that PID's last operations in time order. The **last operation before exit** was the smoking gun:

   ```
   OpenKey "MSSQL16.SQLEXPRESS\MSSQLServer\CurrentVersion" → 0xC0000034 (NAME NOT FOUND)   ← death point
   ```

**Notes:**
- `logman` rejects multiple `-p` flags ("Argument 'p' has been defined too many times") — use one provider per session.
- A hand-written WPR profile also failed schema validation (`0xc5580701`) — `logman` + `tracerpt` is the reliable path.
- `procmon` (Sysinternals) was downloaded but its binary `.pml` output is hard to parse headlessly; kernel ETW → CSV is the scriptable alternative.

---

## 7. The fix

Three elevated, idempotent scripts (in `scripts/`, each self-elevates with one UAC prompt):

| Script | What it does |
|---|---|
| `manual-sql-repair.ps1` | Recursively grants `FullControl` on the entire SQL registry hive (64-bit + WOW6432Node) to the SQL service accounts, Administrators, SYSTEM. Recreates legacy + versioned `CurrentVersion` and `Parameters`. **This fixed the ACL layer** and got the default instance surviving reboots. |
| `fix-sqlexpress-cv.ps1` | Recreates the missing `MSSQL16.SQLEXPRESS\MSSQLServer\CurrentVersion` (= `16.0.1000.6`) plus the WOW6432Node/legacy copies. **This got past instance resolution** (engine began starting, but then failed on Named Pipes). |
| `fix-sqlexpress-netlib.ps1` | **The final fix.** Mirrors the entire working `MSSQLSERVER\MSSQLServer` registry subtree onto `SQLEXPRESS` (skipping `Parameters`, which already pointed to the correct data files), then sets instance-specific values: `Np\PipeName = \\.\pipe\MSSQL$SQLEXPRESS\sql\query`, `Tcp\IPAll\TcpPort = 1435`, `Via` ports → 1435. |

### Key command pattern (recreating a missing subtree from a known-good instance)

```powershell
function Copy-RegTree {
    param([string]$From, [string]$To)
    if (-not (Test-Path $To)) { New-Item -Path $To -Force | Out-Null }
    $item = Get-Item $From
    (Get-ItemProperty $From).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } |
        ForEach-Object { New-ItemProperty -Path $To -Name $_.Name -Value $_.Value -PropertyType $item.GetValueKind($_.Name) -Force | Out-Null }
    Get-ChildItem -Path $From | Where-Object { $_.PSChildName -ne 'Parameters' } |
        ForEach-Object { Copy-RegTree (Join-Path $From $_.PSChildName) (Join-Path $To $_.PSChildName) }
}
```

---

## 8. Verification

After running `fix-sqlexpress-netlib.ps1`:

```
MSSQL$SQLEXPRESS   Running
MSSQLSERVER        Running

sqlcmd -S localhost,1435 -E  → DESKTOP-SKU0HUO\SQLEXPRESS, SQL Server 2022 Express 16.0.1000.6
sqlcmd -S localhost,1433 -E  → DESKTOP-SKU0HUO
named pipe \\.\pipe\MSSQL$SQLEXPRESS\sql\query → connected
TCP 1433 (MSSQLSERVER) and TCP 1435 (SQLEXPRESS) → LISTENING
```

**Instance/port mapping:**
- `MSSQLSERVER` (default) → `localhost,1433`
- `SQLEXPRESS` (named) → `localhost,1435`

---

## 9. Remaining risk / recurrence (ACTION REQUIRED)

- **The registry keys have been deleted before.** The `CurrentVersion` key was recreated on 2026-08-08 and was **missing again by 2026-08-16**. Whatever removes these keys (suspected Ghost-Optimizer-style "cleaner"; no scheduled task/startup entry found yet) is still not identified.
- **After any reboot**, verify both services:

  ```powershell
  Get-Service 'MSSQL$SQLEXPRESS','MSSQLSERVER' | Select Name,Status
  ```

- **If `SQLEXPRESS` is Stopped after a reboot:** re-run `scripts/fix-sqlexpress-netlib.ps1` (and `scripts/fix-sqlexpress-cv.ps1` if needed). Both are idempotent and take seconds.
- **Long-term hardening options:**
  - Register a logon scheduled task that re-runs the netlib fix before/at logon.
  - Or identify and remove the tool that strips the SQL registry (investigate startup items, `HKLM\...\Run`, scheduled tasks, and installed "optimizer" software).

---

## 10. Lessons learned

1. **`sqlservr` can fail before writing its ERRORLOG**, so ERRORLOG absence ≠ "no information." Kernel ETW tracing (`logman` + `tracerpt`) reveals the exact failing registry/file operation.
2. **On this Windows To Go image, do not rely on SQL Setup Repair** — `setup.exe /ACTION=Repair` hung (process sat at 0% CPU; Summary reported "Pending"). Manually repairing registry ACLs and missing keys is the reliable path.
3. **`/FEATURES` is not allowed with `/ACTION=Repair`** (exit `0x84b40005` / `-2068578299`).
4. **SQL Server 2025 does not run on Windows 10 19044** — its setup crashes with `GetNumaNodeProcessorMask2` missing (needs Win11/Server 2022+).
5. **A "working instance can be a template."** When an instance's registry is incomplete, diff it against a healthy sibling instance and mirror the missing subtree (adjusting instance-specific values).
6. **PowerShell script gotcha:** `Log "text {0:X8}" -f $value` applies `-f` as a *named argument to the function*, not the format operator — wrap the format string in parentheses: `Log ("text {0:X8}" -f $value)`.
7. **Non-ASCII characters in `.ps1` files break Windows PowerShell 5.1 parsing** (reads as ANSI) — keep scripts ASCII-only.

---

## 11. Related files

### Active (in `scripts/`)

| File | Purpose |
|---|---|
| `check-sql-health.ps1` | **Integrity check** — verifies both services, ports, critical registry keys, `DB_Oswald`, `api_user` auth, and Oswald endpoints. Run after any reboot (exit 0 = all good). |
| `fix-sqlexpress-cv.ps1` | Recreate missing `CurrentVersion` key (idempotent) |
| `fix-sqlexpress-netlib.ps1` | Mirror full `MSSQLServer` subtree from working instance + instance-specific values (idempotent) — re-run if SQLEXPRESS stops after a reboot |
| `setup-sqlexpress-db.ps1` | Create `DB_Oswald` + `api_user` login in SQLEXPRESS from schema + migrations (re-runnable) |
| `bootstrap-fresh-machine.ps1` | One-click bootstrap; includes LocalDB fallback + `Invoke-SqlScript` single-connection fix + skips migration `001` |
| `smoke-test.js`, `create-account.js`, `reset-password.js`, `cleanup-resources.js`, `backup-before-reinstall.ps1` | Regression suite + user/utility scripts |

### Archived (in `scripts/archive/sql-debug-2026-08/`)

The one-off SQL install/debug/experiment scripts from this investigation are archived there (recoverable): `diag-sql.ps1`, `repair-sql.ps1`, `reinstall-sql.ps1`, `install-*.ps1`, `experiment-protocol.ps1`, `test-localdb-tcp.ps1`, `test-sql-restart.ps1`, `sql-decisive-test.ps1`, `sqlexpress-start-diag.ps1`, `etw-*-capture.ps1`, `fix-port-conflict.ps1`, `manual-sql-repair.ps1`, `sql-repair-2022.ps1`, plus the personal `download-*`/`extract-har` scripts. `archive/archive-old-sql-scripts.ps1` is the script that performed the archiving.

---

*Last updated: 2026-08-16*
