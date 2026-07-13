#!/usr/bin/env python3
"""Print the latest Telegram login code sent to the Cicero account.

Telegram delivers login codes as a message from the official service chat
(id 777000) to all logged-in sessions — including this one. When you sign the
account into a new phone, run this to read the code instead of needing SMS:

    uv run --python ~/.cicero/tgcalls-venv -- python sidecars/telegram-call/read_login_code.py
"""
import os
import re
import sys
from pathlib import Path

from call_security import (
    ensure_private_directory,
    load_env_file,
    redact_secrets,
    secure_session_files,
)

try:
    load_env_file(Path(__file__).resolve().parents[2] / ".env")
except (OSError, ValueError) as exc:
    sys.exit(f"Refusing insecure/invalid .env: {redact_secrets(exc)}")

api_id = os.environ.get("CICERO_TG_API_ID")
api_hash = os.environ.get("CICERO_TG_API_HASH")
if not api_id or not api_hash:
    sys.exit("Set CICERO_TG_API_ID and CICERO_TG_API_HASH first.")

from pyrogram import Client  # noqa: E402

TELEGRAM_SERVICE = 777000
home = Path.home() / ".cicero"
workdir = home / "telegram-call"
try:
    ensure_private_directory(home)
    secure_session_files(workdir)
except (OSError, PermissionError) as exc:
    sys.exit(f"Refusing insecure Telegram session path: {redact_secrets(exc, api_hash)}")

try:
    with Client("cicero", api_id=int(api_id), api_hash=api_hash,
                workdir=str(workdir)) as app:
        found = False
        for msg in app.get_chat_history(TELEGRAM_SERVICE, limit=5):
            code = re.search(r"\b(\d{5,6})\b", msg.text or "")
            if code:
                print("Login codes are credentials; use this once and clear the terminal afterward.")
                print(f"[{msg.date}] login code: {code.group(1)}")
                found = True
                break
        if not found:
            print("No recent login code in the service chat — trigger the login first, then rerun.")
finally:
    secure_session_files(workdir)
