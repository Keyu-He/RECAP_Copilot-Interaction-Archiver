#!/usr/bin/env python3
"""
Replay viewer for student coding sessions.

Starts a local web server that merges shadow git commits and chat session
prompts/responses into a chronological timeline.

Usage:
    python replay_server.py ../filtered_i1-zulip/              # all students
    python replay_server.py ../filtered_i1-zulip/0a3516...     # single student
    python replay_server.py ../filtered_i1-zulip/ --port 8080  # custom port
    python replay_server.py ../filtered_i1-zulip/0a3516... -o timeline.json  # export JSON
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

from timeline_builder import build_timeline


def start_server(base_dir: Path, port: int = 8000):
    """Start a local HTTP server with API endpoints for the replay viewer.

    base_dir can be either:
      - A parent directory containing multiple student subdirectories
      - A single student directory (auto-detected by presence of
        shadow_git_repo/ or chat_sessions/)
    """
    import http.server
    import urllib.parse
    import webbrowser

    viewer_html_path = Path(__file__).parent / "replay_viewer.html"

    import re
    HASH_RE = re.compile(r'^[0-9a-f]{64}$', re.IGNORECASE)

    # Detect mode:
    #   single-student:  base_dir contains shadow_git_repo/ or chat_sessions/
    #   multi-student:   base_dir contains 64-hex subdirs
    #   multi-project:   base_dir contains non-hex subdirs that each contain 64-hex subdirs
    def _load_project_dirs(project_dir: Path) -> dict[str, Path]:
        """Return {student_hash: path} for a single project directory."""
        is_single = (project_dir / "shadow_git_repo").is_dir() or \
                    (project_dir / "chat_sessions").is_dir()
        if is_single:
            return {project_dir.name: project_dir}
        return {d.name: d for d in sorted(project_dir.iterdir())
                if d.is_dir() and HASH_RE.match(d.name)}

    # Detect if base_dir is multi-project
    subdirs = [d for d in sorted(base_dir.iterdir()) if d.is_dir()]
    is_multi_project = subdirs and not any(
        HASH_RE.match(d.name) or
        (d / "shadow_git_repo").is_dir() or
        (d / "chat_sessions").is_dir()
        for d in subdirs
    )

    if is_multi_project:
        projects = [d.name for d in subdirs]
        project_student_dirs: dict[str, dict[str, Path]] = {
            d.name: _load_project_dirs(d) for d in subdirs
        }
        print(f"Multi-project mode: {projects}")
    else:
        projects = []
        project_student_dirs = {}

    # Default (current project) student_dirs
    student_dirs = _load_project_dirs(base_dir) if not is_multi_project else \
                   (project_student_dirs[projects[0]] if projects else {})

    # Cache timelines and their JSON — keyed by (project, student_hash)
    timeline_cache: dict[tuple, str] = {}

    def get_student_dirs_for_project(project: str | None) -> dict[str, Path]:
        if project and project in project_student_dirs:
            return project_student_dirs[project]
        return student_dirs

    def get_student_dir(student_hash: str, project: str | None = None) -> Path | None:
        return get_student_dirs_for_project(project).get(student_hash)

    def get_timeline_json(student_hash: str, project: str | None = None) -> str | None:
        cache_key = (project, student_hash)
        if cache_key in timeline_cache:
            return timeline_cache[cache_key]
        sdir = get_student_dir(student_hash, project)
        if not sdir:
            return None

        # Try pre-processed file first
        processed = sdir / "processed_timeline.json"
        if processed.is_file():
            print(f"Loading pre-processed timeline for {student_hash[:12]}...")
            j = processed.read_text(encoding="utf-8")
        else:
            print(f"Building timeline for {student_hash[:12]} (no pre-processed file)...")
            tl = build_timeline(sdir)
            j = json.dumps(tl, ensure_ascii=False)

        timeline_cache[cache_key] = j
        return j

    # Pre-build first student if single mode
    default_student = list(student_dirs.keys())[0] if student_dirs else None
    if not is_multi_project and default_student:
        get_timeline_json(default_student)

    class ReplayHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)

            if parsed.path == "/" or parsed.path == "/index.html":
                self._serve_file(viewer_html_path, "text/html")

            elif parsed.path == "/api/projects":
                self._json_response(json.dumps(projects))

            elif parsed.path == "/api/students":
                project = params.get("project", [None])[0]
                dirs = get_student_dirs_for_project(project)
                students = []
                for h, d in dirs.items():
                    students.append({
                        "hash": h,
                        "short": h[:12],
                        "has_git": (d / "shadow_git_repo").is_dir(),
                        "has_chat": (d / "chat_sessions").is_dir(),
                    })
                self._json_response(json.dumps(students))

            elif parsed.path == "/api/timeline":
                project = params.get("project", [None])[0]
                dirs = get_student_dirs_for_project(project)
                default = list(dirs.keys())[0] if dirs else None
                student = params.get("student", [default])[0]
                if not student:
                    self._json_response('{"error":"no student specified"}', 400)
                    return
                tj = get_timeline_json(student, project)
                if tj is None:
                    self._json_response('{"error":"student not found"}', 404)
                    return
                self._json_response(tj)

            elif parsed.path == "/api/file":
                project = params.get("project", [None])[0]
                student = params.get("student", [default_student])[0]
                sdir = get_student_dir(student, project) if student else None
                repo_path = sdir / "shadow_git_repo" if sdir else None
                commit = params.get("commit", ["HEAD"])[0]
                fpath = params.get("path", [""])[0]
                if not fpath or not repo_path:
                    self._json_response('{"error":"missing path or student"}', 400)
                    return
                try:
                    result = subprocess.run(
                        ["git", "-C", str(repo_path), "show",
                         f"{commit}:{fpath}"],
                        capture_output=True, text=True, timeout=10,
                    )
                    if result.returncode == 0:
                        self._json_response(json.dumps({
                            "path": fpath,
                            "commit": commit,
                            "content": result.stdout,
                        }))
                    else:
                        self._json_response(json.dumps({
                            "error": result.stderr.strip()
                        }), 404)
                except Exception as e:
                    self._json_response(json.dumps({"error": str(e)}), 500)

            elif parsed.path == "/api/files":
                project = params.get("project", [None])[0]
                student = params.get("student", [default_student])[0]
                sdir = get_student_dir(student, project) if student else None
                repo_path = sdir / "shadow_git_repo" if sdir else None
                commit = params.get("commit", ["HEAD"])[0]
                if not repo_path:
                    self._json_response('[]')
                    return
                try:
                    result = subprocess.run(
                        ["git", "-C", str(repo_path), "ls-tree",
                         "-r", "--name-only", commit],
                        capture_output=True, text=True, timeout=10,
                    )
                    files = sorted(result.stdout.strip().split("\n")) \
                        if result.returncode == 0 else []
                    self._json_response(json.dumps(files))
                except Exception as e:
                    self._json_response(json.dumps({"error": str(e)}), 500)

            else:
                self.send_error(404)

        def _serve_file(self, fpath, content_type):
            try:
                content = fpath.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", len(content))
                self.send_header("Cache-Control", "no-cache, no-store")
                self.end_headers()
                self.wfile.write(content)
            except FileNotFoundError:
                self.send_error(404)

        def _json_response(self, body, status=200):
            data = body.encode("utf-8", errors="replace")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(data))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format, *args):
            # Quiet logging — only log errors
            if args and "200" not in str(args[1]):
                super().log_message(format, *args)

    print(f"\n{len(student_dirs)} student(s) available")
    server = http.server.HTTPServer(("127.0.0.1", port), ReplayHandler)
    url = f"http://127.0.0.1:{port}"
    print(f"Serving replay viewer at {url}")
    print(f"  Press Ctrl+C to stop\n")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")


def main():
    parser = argparse.ArgumentParser(
        description="Build a unified timeline JSON for the replay viewer"
    )
    parser.add_argument("directory", type=Path,
                        help="Path to a student directory or parent directory "
                             "containing multiple students")
    parser.add_argument("-o", "--output", type=Path,
                        default=None,
                        help="Export a single student's timeline to JSON "
                             "instead of starting the server")
    parser.add_argument("--port", type=int, default=8000,
                        help="Port for the local server (default: 8000)")
    args = parser.parse_args()

    if not args.directory.is_dir():
        print(f"Error: {args.directory} not found", file=sys.stderr)
        sys.exit(1)

    if args.output:
        timeline = build_timeline(args.directory)
        args.output.write_text(
            json.dumps(timeline, indent=2, ensure_ascii=False))
        print(f"\nTimeline written to: {args.output}")
        print(f"  {timeline['git_commits']} git commits + "
              f"{timeline['chat_prompts']} chat prompts = "
              f"{timeline['total_events']} events")
    else:
        start_server(args.directory, args.port)


if __name__ == "__main__":
    main()
