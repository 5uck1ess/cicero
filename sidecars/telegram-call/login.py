#!/usr/bin/env python3
"""One-time Telegram login for the Cicero call agent.

Run this INTERACTIVELY in your own terminal (it asks for the phone number and
the login code Telegram sends). The session persists under
~/.cicero/telegram-call/ so the call agent never asks again.

    uv run --python ~/.cicero/tgcalls-venv -- python sidecars/telegram-call/login.py

Needs CICERO_TG_API_ID and CICERO_TG_API_HASH in the environment or in
~/LocalDev/cicero/.env (the daemon's env file).
"""
import os
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
    sys.exit("Set CICERO_TG_API_ID and CICERO_TG_API_HASH (in the env or in the repo .env) first.")

cicero_home = Path.home() / ".cicero"
workdir = cicero_home / "telegram-call"
try:
    ensure_private_directory(cicero_home)
    secure_session_files(workdir)
except (OSError, PermissionError) as exc:
    sys.exit(f"Refusing insecure Telegram session path: {redact_secrets(exc, api_hash)}")

from pyrogram import Client  # noqa: E402

app = Client("cicero", api_id=int(api_id), api_hash=api_hash, workdir=str(workdir))

try:
    with app:
        me = app.get_me()
        print(f"Logged in as: {me.first_name} (@{me.username})")
        print(f"Session saved under {workdir} — the call agent is ready.")
finally:
    secure_session_files(workdir)
