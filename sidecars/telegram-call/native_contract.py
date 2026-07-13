"""Credential-free import/API smoke test for the Telegram call runtime.

Run through the pinned requirements file; this catches upstream API drift that
the standard-library policy tests intentionally cannot import.
"""

from __future__ import annotations

import sys

import numpy as np
import websockets
import yaml
from pyrogram import Client
from pytgcalls import PyTgCalls
from pytgcalls.types import CallConfig, Device, Frame

from call_security import disable_websocket_redirects, websocket_auth_kwargs


def main() -> None:
    if sys.version_info[:2] != (3, 11):
        raise RuntimeError("Telegram call runtime must be checked on Python 3.11")
    for owner, method in (
        (PyTgCalls, "start"),
        (PyTgCalls, "play"),
        (PyTgCalls, "record"),
        (PyTgCalls, "send_frame"),
        (PyTgCalls, "leave_call"),
        (Client, "start"),
        (Client, "stop"),
    ):
        value = getattr(owner, method, None)
        if value is None or not callable(value):
            raise RuntimeError(f"required runtime API is missing: {owner.__name__}.{method}")
    auth = websocket_auth_kwargs(
        websockets.connect,
        "contract-token",
        version=websockets.__version__,
    )
    if list(auth.values()) != [{"Authorization": "Bearer contract-token"}]:
        raise RuntimeError("websockets client cannot carry header-based bearer auth")
    disable_websocket_redirects(websockets.connect)
    CallConfig(timeout=1)
    Frame.Info(capture_time=0)
    if Device.MICROPHONE is None or np.dtype(np.int16).itemsize != 2:
        raise RuntimeError("native audio contract is unavailable")
    if yaml.safe_load("enabled: true") != {"enabled": True}:
        raise RuntimeError("PyYAML contract is unavailable")
    print("telegram-call native dependency contract: ok")


if __name__ == "__main__":
    main()
