#!/usr/bin/env python3
import argparse
import contextlib
import http.server
import json
import os
import pty
import re
import select
import socket
import subprocess
import threading
import time


ANSI_RE = re.compile(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_]|[PX^_].*?(?:\x1b\\|\x07))")


def parse_args():
    parser = argparse.ArgumentParser(description="Drive pi-canvas through a browser-addressable Pi terminal.")
    parser.add_argument("--extension", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--agent-dir", required=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--terminal-transcript", required=True)
    parser.add_argument("--raw-transcript", required=True)
    parser.add_argument("--browser-snapshot", required=True)
    parser.add_argument("--browser-screenshot", required=True)
    parser.add_argument("--browser-log", required=True)
    parser.add_argument("--session", required=True)
    return parser.parse_args()


def strip_terminal(text):
    return ANSI_RE.sub("", text).replace("\r", "")


def find_free_port():
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def bool_from_stdout(stdout):
    value = stdout.strip()
    try:
        return json.loads(value) is True
    except json.JSONDecodeError:
        return value == "true"


def html_page():
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pi Canvas Browser Terminal</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #f5f7f9;
      color: #17212b;
      font: 14px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 10px;
      min-height: 100vh;
      padding: 14px;
    }
    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0;
    }
    #terminal {
      overflow: auto;
      min-height: 360px;
      max-height: calc(100vh - 116px);
      margin: 0;
      border: 1px solid #b9c2cc;
      border-radius: 6px;
      background: #101418;
      color: #d9f0df;
      padding: 12px;
      font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .input-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: stretch;
    }
    #terminal-input {
      width: 100%;
      min-height: 42px;
      resize: vertical;
      border: 1px solid #9aa7b4;
      border-radius: 6px;
      padding: 8px 10px;
      font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #fff;
      color: #17212b;
    }
    #send-raw {
      min-width: 96px;
      border: 1px solid #596979;
      border-radius: 6px;
      background: #243648;
      color: #fff;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main>
    <h1>Pi Canvas Terminal</h1>
    <pre id="terminal" data-testid="terminal" aria-live="polite"></pre>
    <div class="input-row">
      <textarea id="terminal-input" data-testid="terminal-input" aria-label="Terminal input" autofocus></textarea>
      <button id="send-raw" type="button">Send raw</button>
    </div>
  </main>
  <script>
    const terminal = document.querySelector("#terminal");
    const input = document.querySelector("#terminal-input");
    const sendRawButton = document.querySelector("#send-raw");

    async function refreshTerminal() {
      const response = await fetch("/snapshot", { cache: "no-store" });
      const snapshot = await response.json();
      terminal.textContent = snapshot.text;
      terminal.scrollTop = terminal.scrollHeight;
    }

    async function sendInput(text) {
      await fetch("/input", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: text,
      });
      await refreshTerminal();
    }

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const value = input.value;
        input.value = "";
        void sendInput(value + "\\r");
      }
    });

    sendRawButton.addEventListener("click", () => {
      const value = input.value;
      input.value = "";
      void sendInput(value);
    });

    setInterval(refreshTerminal, 100);
    void refreshTerminal();
  </script>
</body>
</html>
"""


def main():
    args = parse_args()
    os.makedirs(os.path.dirname(args.terminal_transcript), exist_ok=True)
    os.makedirs(os.path.dirname(args.browser_snapshot), exist_ok=True)
    os.makedirs(args.cwd, exist_ok=True)
    os.makedirs(args.agent_dir, exist_ok=True)
    real_cwd = os.path.realpath(args.cwd)
    terminal_transcript_path = os.path.abspath(args.terminal_transcript)
    raw_transcript_path = os.path.abspath(args.raw_transcript)
    browser_snapshot_path = os.path.abspath(args.browser_snapshot)
    browser_screenshot_path = os.path.abspath(args.browser_screenshot)
    browser_log_path = os.path.abspath(args.browser_log)

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
    browser_log = []
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

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                body = html_page().encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path.startswith("/snapshot"):
                pump(0.02)
                payload = json.dumps({"text": clean()[-40000:]}).encode("utf-8")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("cache-control", "no-store")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            if self.path != "/input":
                self.send_response(404)
                self.end_headers()
                return
            length = int(self.headers.get("content-length", "0"))
            data = self.rfile.read(length)
            try:
                os.write(master, data)
            except OSError:
                pass
            pump(0.1)
            self.send_response(204)
            self.end_headers()

        def log_message(self, fmt, *items):
            return

    port = find_free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}/"

    def run_browser(label, command_args, timeout=15):
        try:
            result = subprocess.run(
                ["agent-browser", "--session", args.session, *command_args],
                text=True,
                capture_output=True,
                timeout=timeout,
            )
        except Exception as error:
            browser_log.append({"label": label, "command": command_args, "exitCode": None, "stdout": "", "stderr": str(error)})
            return None
        browser_log.append({
            "label": label,
            "command": command_args,
            "exitCode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        })
        return result

    def wait_terminal_contains(label, needle, timeout=8.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if needle in clean():
                checks[label] = True
                return True
            pump(0.1)
        checks[label] = False
        return False

    def browser_contains(label, needle):
        expression = f"document.querySelector('#terminal')?.innerText.includes({json.dumps(needle)}) === true"
        result = run_browser(label, ["eval", expression], timeout=10)
        matched = result is not None and result.returncode == 0 and bool_from_stdout(result.stdout)
        checks[label] = matched
        return matched

    def wait_browser_contains(label, needle, timeout=8.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            pump(0.1)
            if browser_contains(label, needle):
                return True
            time.sleep(0.25)
        checks[label] = False
        return False

    def send_line(label, value):
        fill = run_browser(f"{label}_fill", ["fill", "#terminal-input", value], timeout=10)
        press = run_browser(f"{label}_enter", ["press", "Enter"], timeout=10)
        ok = fill is not None and fill.returncode == 0 and press is not None and press.returncode == 0
        checks[f"{label}_sent"] = ok
        return ok

    def send_raw(label, value):
        fill = run_browser(f"{label}_fill", ["fill", "#terminal-input", value], timeout=10)
        click = run_browser(f"{label}_send_raw", ["click", "#send-raw"], timeout=10)
        ok = fill is not None and fill.returncode == 0 and click is not None and click.returncode == 0
        checks[f"{label}_sent"] = ok
        return ok

    try:
        wait_terminal_contains("startup_terminal", "No models available", 5.0)
        run_browser("open", ["open", url], timeout=25)
        run_browser("wait_input", ["wait", "#terminal-input"], timeout=10)
        wait_browser_contains("startup_browser", "No models available", 5.0)

        send_line("create", f"/canvas create-counter {args.artifact_id} 0")
        wait_terminal_contains("created_event", '"event":"created"', 5.0)
        wait_browser_contains("created_browser", '"event":"created"', 5.0)
        observable_events.append(f"browser terminal command create {args.artifact_id}")

        send_line("open_tui", f"/canvas open {args.artifact_id}")
        wait_terminal_contains("tui_rendered_terminal", f"pi-canvas: {args.artifact_id}", 5.0)
        wait_browser_contains("tui_rendered_browser", f"pi-canvas: {args.artifact_id}", 5.0)
        observable_events.append(f"browser terminal command open {args.artifact_id}")

        send_raw("increment", "+")
        wait_terminal_contains("tui_state_terminal", "Count: 1", 5.0)
        wait_browser_contains("tui_state_browser", "Count: 1", 5.0)
        observable_events.append("browser terminal input +")

        send_raw("export", "e")
        wait_terminal_contains("tui_export_terminal", "exported:", 5.0)
        wait_browser_contains("tui_export_browser", "exported:", 5.0)
        observable_events.append("browser terminal input e")

        send_raw("close_tui", "q")
        wait_terminal_contains("tui_closed_event", '"event":"tui-closed"', 5.0)
        wait_browser_contains("tui_closed_browser", '"event":"tui-closed"', 5.0)
        observable_events.append("browser terminal input q")

        send_line("read", f"/canvas read {args.artifact_id}")
        wait_terminal_contains("read_event", '"event":"read"', 5.0)
        wait_terminal_contains("read_state", '"state":{"count":1}', 2.0)
        wait_browser_contains("read_browser", '"event":"read"', 5.0)
        wait_browser_contains("read_state_browser", '"state":{"count":1}', 5.0)
        observable_events.append(f"browser terminal command read {args.artifact_id}")

        text_result = run_browser("terminal_text", ["get", "text", "#terminal"], timeout=10)
        if text_result is not None and text_result.returncode == 0:
            with open(terminal_transcript_path, "w", encoding="utf-8") as file:
                file.write(text_result.stdout)
        else:
            with open(terminal_transcript_path, "w", encoding="utf-8") as file:
                file.write(clean())

        snapshot_result = run_browser("snapshot", ["snapshot", "-s", "#terminal"], timeout=10)
        with open(browser_snapshot_path, "w", encoding="utf-8") as file:
            if snapshot_result is not None:
                file.write(snapshot_result.stdout)

        browser_log.append({
            "label": "screenshot",
            "command": ["screenshot", browser_screenshot_path],
            "exitCode": None,
            "stdout": "",
            "stderr": "skipped; DOM transcript and accessibility snapshot are the browser evidence for this harness",
        })
    finally:
        try:
            run_browser("close", ["close"], timeout=10)
        except Exception:
            pass
        try:
            server.shutdown()
        except Exception:
            pass
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
    with open(raw_transcript_path, "w", encoding="utf-8") as file:
        file.write(raw_text)
    with open(browser_log_path, "w", encoding="utf-8") as file:
        file.write(json.dumps(browser_log, indent=2))
        file.write("\n")

    print(json.dumps({
        "agentDir": args.agent_dir,
        "cwd": real_cwd,
        "url": url,
        "session": args.session,
        "terminalTranscriptPath": terminal_transcript_path,
        "rawTranscriptPath": raw_transcript_path,
        "browserSnapshotPath": browser_snapshot_path,
        "browserScreenshotPath": browser_screenshot_path if os.path.exists(browser_screenshot_path) else "",
        "browserLogPath": browser_log_path,
        "checks": checks,
        "observableEvents": observable_events,
    }))


if __name__ == "__main__":
    main()
