@echo off
rem ============================================================
rem  Portable launcher for Update-Firmware.ps1
rem  ------------------------------------------------------------
rem  Double-click for the interactive menu.
rem  For BIOS/SSD/NIC flashing: right-click -> Run as administrator.
rem
rem  Examples (from a command prompt in this folder):
rem    Run-Firmware-Update.cmd help
rem    Run-Firmware-Update.cmd consumer -DiscoverOnly
rem    Run-Firmware-Update.cmd all
rem ============================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Firmware.ps1" %*
if errorlevel 1 pause
