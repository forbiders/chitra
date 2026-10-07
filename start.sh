#!/bin/bash
# keep the phone awake while the server runs (stops Android killing Termux)
command -v termux-wake-lock >/dev/null && termux-wake-lock
cd /root/work/fmhy/addon
PORT=7123 npx tsx src/server.ts
