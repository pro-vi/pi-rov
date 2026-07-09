#!/usr/bin/env python3
import argparse
import json
import os
import pty
import re
import select
import subprocess
import time


ANSI_RE = re.compile(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|[PX^_].*?(?:\x1b\\|\x07))")


def parse_args():
    parser = argparse.ArgumentParser(description="Drive pi-canvas through a live Pi TTY.")
    parser.add_argument("--extension", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--agent-dir", required=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--raw-transcript", required=True)
    return parser.parse_args()


def strip_terminal(text):
    return ANSI_RE.sub("", text).replace("\r", "")


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.transcript), exist_ok=True)
    os.makedirs(args.cwd, exist_ok=True)
    os.makedirs(args.agent_dir, exist_ok=True)
    real_cwd = os.path.realpath(args.cwd)

    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = args.agent_dir
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = "100"
    env["LINES"] = "30"
    command = [
        "pi",
        "--offline",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "-e",
        args.extension,
    ]

    master, slave = pty.openpty()
    process = subprocess.Popen(command, cwd=real_cwd, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    os.set_blocking(master, False)

    raw = bytearray()
    checks = {}
    observable_events = []

    def pump(seconds=0.1):
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.05)
            if not ready:
                continue
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                continue
            except OSError:
                return
            if not data:
                return
            raw.extend(data)

    def clean():
        return strip_terminal(raw.decode("utf-8", "ignore"))

    def wait_contains(label, needle, timeout=8.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if needle in clean():
                checks[label] = True
                return True
            pump(0.1)
        checks[label] = False
        return False

    def send(value):
        os.write(master, value.encode("utf-8"))
        pump(0.2)

    try:
        wait_contains("startup", "No models available", 5.0)
        send(f"/canvas create-counter {args.artifact_id} 0\r")
        wait_contains("created_event", '"event":"created"', 5.0)
        observable_events.append(f"tty command create {args.artifact_id}")

        send(f"/canvas open {args.artifact_id}\r")
        wait_contains("tui_rendered", f"pi-canvas: {args.artifact_id}", 5.0)
        observable_events.append(f"tty command open {args.artifact_id}")

        send("+")
        wait_contains("tui_state_rendered", "Count: 1", 5.0)
        observable_events.append("tty input +")

        send("e")
        wait_contains("tui_export_rendered", "exported:", 5.0)
        observable_events.append("tty input e")

        send("q")
        wait_contains("tui_closed_event", '"event":"tui-closed"', 5.0)
        observable_events.append("tty input q")

        send(f"/canvas read {args.artifact_id}\r")
        wait_contains("read_event", '"event":"read"', 5.0)
        wait_contains("read_state", '"state":{"count":1}', 2.0)
        observable_events.append(f"tty command read {args.artifact_id}")
    finally:
        try:
            os.write(master, b"\x03")
        except OSError:
            pass
        try:
            process.terminate()
            process.wait(timeout=2)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    raw_text = raw.decode("utf-8", "ignore")
    clean_text = strip_terminal(raw_text)
    with open(args.raw_transcript, "w", encoding="utf-8") as file:
        file.write(raw_text)
    with open(args.transcript, "w", encoding="utf-8") as file:
        file.write(clean_text)

    print(json.dumps({
        "agentDir": args.agent_dir,
        "cwd": real_cwd,
        "transcriptPath": args.transcript,
        "rawTranscriptPath": args.raw_transcript,
        "checks": checks,
        "observableEvents": observable_events,
    }))


if __name__ == "__main__":
    main()
