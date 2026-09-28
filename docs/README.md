# Atmoce specifications

The app is built on Atmoce's official Modbus TCP specifications. The PDFs are Atmoce's
documents and are not redistributed in this repository (`docs/*.pdf` is git-ignored);
download them from the sources below and place them here for development.

| Document | Version | Source |
|---|---|---|
| Atmoce Gateway and SCU Modbus Protocol Interface Description | **V1.6**, 2026-04-18 (current) | Loxone library, plugin 1849 (published by Atmoce Deutschland GmbH): `https://api.library.loxone.com/downloader/file/3137/Atmoce%20Gateway%20and%20SCU%20Modbus_Protocol%20Interface%20Description%201.6.pdf` |
| Atmoce Gateway Modbus Protocol Interface Description | V1.2, 2025-10-23 | Attached in the wiki of the Home Assistant integration `pacorola/Atmoce_battery_HA` |
| Atmoce Gateway Modbus Protocol Interface Description | V1.0, 2025-02-25 | Loxone library: `https://api.library.loxone.com/downloader/file/2322/Atmoce%20Gateway%20Modbus_Protocol%20Interface%20Description_en.pdf` |

The Loxone downloader only returns the file when the URL ends in the exact file name.
See `AGENTS.md` for how each register is used and what has been verified on hardware.
