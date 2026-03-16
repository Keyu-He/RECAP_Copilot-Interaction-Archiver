#!/usr/bin/env python3
"""
Shared extraction and enrichment logic for building coding session timelines.

Reads shadow git repos and Copilot chat_session.json files, extracts events,
performs AI edit attribution, and assembles unified timelines.

Used by both replay_server.py (serving) and preprocess.py (batch processing).
"""

import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def ms_to_iso(ts_ms):
    """Convert Unix milliseconds to ISO 8601 string."""
    if ts_ms is None:
        return None
    try:
        dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    except (OSError, ValueError):
        return None


def iso_to_epoch(iso_str):
    """Convert ISO string to epoch seconds for sorting."""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.timestamp()
    except (ValueError, AttributeError):
        return 0


# ---------------------------------------------------------------------------
# File type classification
# ---------------------------------------------------------------------------

_CODE_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h", ".hpp",
    ".cs", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".scala", ".sh",
    ".bash", ".zsh", ".pl", ".r", ".m", ".sql", ".html", ".css", ".scss",
    ".less", ".vue", ".svelte", ".hbs", ".ejs", ".pug",
    ".cjs", ".mjs", ".erb", ".pp",
}
_CONFIG_EXTS = {
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".properties", ".lock",
}
_DOC_EXTS = {".md", ".mdx", ".txt", ".rst", ".adoc", ".org", ".tex", ".rtf"}


def classify_file_type(path: str) -> str:
    """Classify a file path into code/config/docs/other."""
    ext = "." + path.rsplit(".", 1)[1].lower() if "." in path else ""
    if ext in _CODE_EXTS:
        return "code"
    if ext in _DOC_EXTS:
        return "docs"
    if ext in _CONFIG_EXTS:
        return "config"
    return "other"


# ---------------------------------------------------------------------------
# Git extraction
# ---------------------------------------------------------------------------

def extract_git_events(repo_path: Path) -> list[dict]:
    """Extract commits from the shadow git repo as timeline events."""
    events = []

    result = subprocess.run(
        ["git", "-C", str(repo_path), "log",
         "--format=%H|%aI|%s", "--reverse"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        print(f"Error reading git log: {result.stderr}", file=sys.stderr)
        return events

    commits = result.stdout.strip().split("\n")
    prev_hash = None

    for line in commits:
        if not line.strip():
            continue
        parts = line.split("|", 2)
        if len(parts) < 3:
            continue
        commit_hash, timestamp, message = parts

        if prev_hash:
            diff_result = subprocess.run(
                ["git", "-C", str(repo_path), "diff",
                 prev_hash, commit_hash],
                capture_output=True, text=True, timeout=30,
            )
            diff_text = diff_result.stdout if diff_result.returncode == 0 else ""

            stat_result = subprocess.run(
                ["git", "-C", str(repo_path), "diff",
                 "--name-status", prev_hash, commit_hash],
                capture_output=True, text=True, timeout=30,
            )
            changed_files = []
            if stat_result.returncode == 0:
                for stat_line in stat_result.stdout.strip().split("\n"):
                    if stat_line.strip():
                        parts2 = stat_line.split("\t", 1)
                        if len(parts2) == 2:
                            changed_files.append({
                                "status": parts2[0],
                                "path": parts2[1],
                                "file_type": classify_file_type(parts2[1]),
                            })
        else:
            diff_result = subprocess.run(
                ["git", "-C", str(repo_path), "diff",
                 "--root", commit_hash],
                capture_output=True, text=True, timeout=30,
            )
            diff_text = diff_result.stdout if diff_result.returncode == 0 else ""

            # Extract actual files for initial commit
            stat_result = subprocess.run(
                ["git", "-C", str(repo_path), "diff",
                 "--root", "--name-status", commit_hash],
                capture_output=True, text=True, timeout=30,
            )
            changed_files = []
            if stat_result.returncode == 0:
                for stat_line in stat_result.stdout.strip().split("\n"):
                    if stat_line.strip():
                        parts2 = stat_line.split("\t", 1)
                        if len(parts2) == 2:
                            changed_files.append({
                                "status": parts2[0],
                                "path": parts2[1],
                                "file_type": classify_file_type(parts2[1]),
                            })
            if not changed_files:
                changed_files = [{"status": "A", "path": "(initial commit)", "file_type": "other"}]

        # Cap huge diffs (e.g. initial commits with entire codebase)
        MAX_DIFF_BYTES = 5_000_000  # 5 MB
        if len(diff_text) > MAX_DIFF_BYTES:
            diff_text = (f"(diff too large: {len(diff_text)//1024} KB, "
                         f"{len(changed_files)} files — omitted)")

        events.append({
            "type": "git_commit",
            "timestamp": timestamp,
            "epoch": iso_to_epoch(timestamp),
            "commit_hash": commit_hash,
            "message": message,
            "changed_files": changed_files,
            "diff": diff_text,
        })

        prev_hash = commit_hash

    return events


# ---------------------------------------------------------------------------
# Chat extraction — enriched
# ---------------------------------------------------------------------------

def _extract_context(req: dict) -> dict:
    """Extract attached files and workspace context from a request."""
    attached_files = []
    has_workspace = False

    variable_data = req.get("variableData", {})
    variables = variable_data.get("variables", [])
    if not isinstance(variables, list):
        variables = []

    for var in variables:
        if not isinstance(var, dict):
            continue
        kind = var.get("kind", "")

        if kind == "workspace":
            has_workspace = True
            continue

        if kind == "file":
            value = var.get("value", {})
            # Value can be a URI object or a dict with uri + range
            if isinstance(value, dict):
                path = value.get("path") or value.get("fsPath", "")
                uri = value.get("uri", {})
                if uri:
                    path = uri.get("path") or uri.get("fsPath", "") or path

                # Check for selection range
                selection = None
                r = value.get("range", {})
                if r and isinstance(r, dict):
                    selection = {
                        "start_line": r.get("startLineNumber"),
                        "start_column": r.get("startColumn"),
                        "end_line": r.get("endLineNumber"),
                        "end_column": r.get("endColumn"),
                    }

                attached_files.append({
                    "path": path,
                    "name": var.get("name", ""),
                    "selection": selection,
                })

    return {
        "attached_files": attached_files,
        "has_workspace": has_workspace,
    }


def _extract_tool_calls(response_parts: list) -> list[dict]:
    """Extract tool invocations from response parts."""
    tool_calls = []

    for part in response_parts:
        if not isinstance(part, dict):
            continue
        if part.get("kind") != "toolInvocationSerialized":
            continue

        tool_id = part.get("toolId", "")

        # Extract action/result messages (can be string or dict with value)
        inv_msg = part.get("invocationMessage", "")
        if isinstance(inv_msg, dict):
            inv_msg = inv_msg.get("value", "")
        past_msg = part.get("pastTenseMessage", "")
        if isinstance(past_msg, dict):
            past_msg = past_msg.get("value", "")

        is_confirmed_data = part.get("isConfirmed", {})
        is_confirmed = True
        if isinstance(is_confirmed_data, dict):
            # type 1 = auto, type 4 = user-confirmed
            is_confirmed = is_confirmed_data.get("type", 1) in (1, 4)

        entry = {
            "tool_id": tool_id,
            "action": inv_msg,
            "result": past_msg,
            "is_confirmed": is_confirmed,
        }

        # Terminal-specific data
        tsd = part.get("toolSpecificData", {})
        if isinstance(tsd, dict) and tsd.get("kind") == "terminal":
            cmd_line = tsd.get("commandLine", {})
            cmd_state = tsd.get("terminalCommandState", {})
            cmd_output = tsd.get("terminalCommandOutput", {})
            entry["terminal"] = {
                "command": cmd_line.get("original", "") if isinstance(cmd_line, dict) else "",
                "exit_code": cmd_state.get("exitCode") if isinstance(cmd_state, dict) else None,
                "output": cmd_output.get("text", "") if isinstance(cmd_output, dict) else "",
                "output_lines": cmd_output.get("lineCount", 0) if isinstance(cmd_output, dict) else 0,
            }

        tool_calls.append(entry)

    return tool_calls


def _extract_thinking(response_parts: list) -> list[str]:
    """Extract chain-of-thought reasoning blocks."""
    thinking = []
    for part in response_parts:
        if not isinstance(part, dict):
            continue
        if part.get("kind") == "thinking":
            text = part.get("value", "")
            if text:
                thinking.append(text)
    return thinking


def _extract_confirmations(response_parts: list) -> list[dict]:
    """Extract confirmation dialogs shown to the user."""
    confirmations = []
    for part in response_parts:
        if not isinstance(part, dict):
            continue
        if part.get("kind") != "confirmation":
            continue

        msg = part.get("message", {})
        msg_text = msg.get("value", "") if isinstance(msg, dict) else str(msg)

        confirmations.append({
            "title": part.get("title", ""),
            "message": msg_text,
            "buttons": part.get("buttons", []),
            "is_used": part.get("isUsed", False),
        })
    return confirmations


def _extract_todo_list(response_parts: list) -> list[dict] | None:
    """Extract the last TODO list state from tool-specific data."""
    last_todo = None
    for part in response_parts:
        if not isinstance(part, dict):
            continue
        if part.get("kind") != "toolInvocationSerialized":
            continue
        tsd = part.get("toolSpecificData", {})
        if not isinstance(tsd, dict) or tsd.get("kind") != "todoList":
            continue
        items = tsd.get("todoList", [])
        if isinstance(items, list):
            last_todo = [
                {
                    "id": item.get("id", ""),
                    "title": item.get("title", ""),
                    "description": item.get("description", ""),
                    "status": item.get("status", ""),
                }
                for item in items if isinstance(item, dict)
            ]
    return last_todo


def _extract_edited_files(req: dict) -> list[dict]:
    """Extract files actually modified during a request."""
    edited = []
    events = req.get("editedFileEvents", [])
    if not isinstance(events, list):
        return edited
    for evt in events:
        if not isinstance(evt, dict):
            continue
        uri = evt.get("uri", {})
        path = uri.get("path", "") if isinstance(uri, dict) else ""
        edited.append({
            "path": path,
            "event_kind": evt.get("eventKind"),  # 1=created, 2=deleted, 3=changed
        })
    return edited


def _extract_text_edit_group_summaries(response_parts: list) -> list[dict]:
    """Extract per-turn summaries of textEditGroup entries."""
    summaries = []
    for part in response_parts:
        if not isinstance(part, dict):
            continue
        if part.get("kind") != "textEditGroup":
            continue
        uri = part.get("uri", {})
        file_path = uri.get("path", "") if isinstance(uri, dict) else ""
        edits = part.get("edits", [])

        edit_count = 0
        total_lines = 0
        for edit_group in edits:
            if not edit_group:
                continue
            for edit in edit_group:
                text = edit.get("text", "")
                if text:
                    edit_count += 1
                    total_lines += text.count("\n") + 1

        if edit_count > 0:
            summaries.append({
                "file_path": file_path,
                "edit_count": edit_count,
                "total_lines": total_lines,
            })
    return summaries


def extract_chat_events(chat_sessions_dir: Path) -> list[dict]:
    """Extract enriched chat prompts/responses as timeline events.

    Includes all available fields: context, tool calls, thinking,
    confirmations, timing, terminal commands, etc.
    """
    events = []

    for session_dir in sorted(chat_sessions_dir.iterdir()):
        if not session_dir.is_dir():
            continue

        session_file = session_dir / "chat_session.json"
        if not session_file.is_file():
            continue

        try:
            data = json.loads(session_file.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print(f"Warning: could not parse {session_file}: {e}",
                  file=sys.stderr)
            continue

        session_title = data.get("customTitle", "(untitled)")
        session_id = data.get("sessionId", session_dir.name)

        # Session-level mode (from inputState)
        input_state = data.get("inputState", {})
        session_mode = ""
        if isinstance(input_state, dict):
            mode_obj = input_state.get("mode", {})
            if isinstance(mode_obj, dict):
                session_mode = mode_obj.get("id", "")

        for req in data.get("requests", []):
            prompt_text = req.get("message", {}).get("text", "")
            ts_ms = req.get("timestamp")
            ts_iso = ms_to_iso(ts_ms)
            if not ts_iso:
                continue

            # Extract response text
            response_text = ""
            response_parts = req.get("response", [])
            if isinstance(response_parts, list):
                for part in response_parts:
                    if not isinstance(part, dict):
                        continue
                    kind = part.get("kind")
                    if kind == "text" or \
                       (not kind and part.get("value")):
                        val = (part.get("value") or
                               part.get("text") or "")
                        # Strip orphan code fence markers (from codeblockUri)
                        stripped = re.sub(
                            r"```[a-zA-Z]*\s*```", "", val)
                        stripped = re.sub(
                            r"^\s*```[a-zA-Z]*\s*$", "",
                            stripped, flags=re.MULTILINE)
                        response_text += stripped + "\n"
                    elif kind == "inlineReference":
                        name = part.get("name", "")
                        if name:
                            response_text += f"`{name}` "
                    elif kind == "textEditGroup":
                        uri = part.get("uri", {})
                        fspath = uri.get("fsPath", "") if isinstance(uri, dict) else ""
                        fname = fspath.rsplit("/", 1)[-1] if fspath else "file"
                        response_text += f"[Edited {fname}] "
            # Collapse runs of blank lines
            response_text = re.sub(r"\n{3,}", "\n\n", response_text)

            # Completion time
            completed_ms = None
            model_state = req.get("modelState")
            if isinstance(model_state, dict):
                completed_ms = model_state.get("completedAt")

            # Model info
            model_id = req.get("modelId", "")
            details = ""
            result_data = req.get("result")
            if isinstance(result_data, dict):
                details = result_data.get("details", "")

            # Event type classification
            is_action = prompt_text.startswith("@GitHubCopilot") or \
                prompt_text.startswith("@agent ")
            evt_type = "chat_action" if is_action else "chat_prompt"

            # Timing
            timings = {}
            if isinstance(result_data, dict):
                t = result_data.get("timings", {})
                if isinstance(t, dict):
                    timings = {
                        "first_progress_ms": t.get("firstProgress"),
                        "total_elapsed_ms": t.get("totalElapsed"),
                    }

            # Error
            error = None
            if isinstance(result_data, dict):
                err = result_data.get("errorDetails", {})
                if isinstance(err, dict) and err:
                    parts = []
                    if err.get("message"):
                        parts.append(err["message"])
                    if err.get("isQuotaExceeded"):
                        parts.append("quota_exceeded")
                    if err.get("responseIsIncomplete"):
                        parts.append("incomplete")
                    error = "; ".join(parts) if parts else None

            # Enriched fields from response parts
            rp = response_parts if isinstance(response_parts, list) else []

            evt = {
                "type": evt_type,
                "timestamp": ts_iso,
                "epoch": iso_to_epoch(ts_iso),
                "session_id": session_id,
                "session_title": session_title,
                "request_id": req.get("requestId", ""),
                "prompt": prompt_text,
                "response": response_text.strip(),
                "completed_at": ms_to_iso(completed_ms),
                "model": details or model_id,
                # Enriched fields
                "mode": session_mode,
                "is_canceled": bool(req.get("isCanceled", False)),
                "time_spent_waiting_ms": req.get("timeSpentWaiting"),
                "confirmation_choice": req.get("confirmation"),
                "timings": timings,
                "error": error,
                "context": _extract_context(req),
                "tool_calls": _extract_tool_calls(rp),
                "todo_list": _extract_todo_list(rp),
                "thinking": _extract_thinking(rp),
                "confirmations": _extract_confirmations(rp),
                "edited_files": _extract_edited_files(req),
                "text_edit_groups": _extract_text_edit_group_summaries(rp),
            }

            events.append(evt)

    return events


# ---------------------------------------------------------------------------
# TEG extraction (for AI attribution)
# ---------------------------------------------------------------------------

def extract_text_edit_groups(chat_sessions_dir: Path) -> list[dict]:
    """Extract all textEditGroup entries from chat sessions for AI attribution."""
    tegs = []

    for session_dir in sorted(chat_sessions_dir.iterdir()):
        if not session_dir.is_dir():
            continue

        session_file = session_dir / "chat_session.json"
        if not session_file.is_file():
            continue

        try:
            data = json.loads(session_file.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        for req in data.get("requests", []):
            ts_ms = req.get("timestamp")
            ts_iso = ms_to_iso(ts_ms)
            ts_epoch = iso_to_epoch(ts_iso) if ts_iso else 0
            prompt = req.get("message", {}).get("text", "")

            for part in req.get("response", []):
                if not isinstance(part, dict):
                    continue
                if part.get("kind") != "textEditGroup":
                    continue

                uri = part.get("uri", {})
                full_path = uri.get("path", "")
                edits = part.get("edits", [])

                edit_summary = []
                for edit_group in edits:
                    if not edit_group:
                        continue
                    for edit in edit_group:
                        r = edit.get("range", {})
                        text = edit.get("text", "")
                        edit_summary.append({
                            "start_line": r.get("startLineNumber"),
                            "end_line": r.get("endLineNumber"),
                            "text": text,
                            "lines": text.count("\n"),
                        })

                if edit_summary:
                    tegs.append({
                        "epoch": ts_epoch,
                        "timestamp": ts_iso,
                        "full_path": full_path,
                        "prompt": prompt,
                        "edits": edit_summary,
                    })

    return tegs


# ---------------------------------------------------------------------------
# AI attribution
# ---------------------------------------------------------------------------

def extract_workspace_root(tegs: list[dict], git_files: set[str]) -> str:
    """Infer the workspace root from textEditGroup paths."""
    for teg in tegs:
        fp = teg["full_path"]
        if not fp:
            continue
        parts = fp.split("/")
        for i in range(1, len(parts)):
            candidate = "/".join(parts[i:])
            if candidate in git_files:
                root = "/".join(parts[:i]) + "/"
                return root
    return ""


def _diff_added_text(diff_text: str, fpath: str) -> str:
    """Extract the raw added text from a unified diff for a specific file."""
    lines = diff_text.split("\n") if diff_text else []
    in_file = False
    added_parts = []
    for line in lines:
        if line.startswith("diff --git"):
            in_file = line.endswith(f"b/{fpath}")
        elif in_file and line.startswith("+") and not line.startswith("+++"):
            added_parts.append(line[1:])
    return "\n".join(added_parts)


def _teg_text(teg: dict) -> str:
    """Get the full text content of a TEG's edits, concatenated."""
    parts = []
    for edit in teg.get("edits", []):
        t = edit.get("text", "")
        if t:
            parts.append(t)
    return "\n".join(parts)


def _normalize(text: str) -> str:
    """Normalize text for comparison: strip each line, drop blanks, join."""
    return "\n".join(
        line.strip() for line in text.split("\n")
        if line.strip()
    )


def _line_matches(diff_line: str, teg_lines: set[str]) -> bool:
    """Check if a diff line matches any TEG line.

    Three tiers:
    1. Exact match
    2. Containment (handles partial-line TEGs with startColumn > 1)
    3. Fuzzy similarity >= 0.8 (handles human tweaks to AI-generated lines)
    """
    if diff_line in teg_lines:
        return True
    for tl in teg_lines:
        if len(tl) < 10:
            continue
        if tl in diff_line or diff_line in tl:
            return True
        if len(diff_line) >= 10 and SequenceMatcher(None, diff_line, tl).ratio() >= 0.8:
            return True
    return False


def _exact_match_score(diff_added: str, teg_content: str) -> float:
    """Check how much of the diff's added lines appear in the TEG content."""
    norm_diff = _normalize(diff_added)
    norm_teg = _normalize(teg_content)

    if not norm_diff or not norm_teg:
        return 0.0

    if norm_diff in norm_teg:
        return 1.0

    teg_lines = set(norm_teg.split("\n"))
    diff_lines = norm_diff.split("\n")
    if not diff_lines:
        return 0.0
    matched = sum(1 for l in diff_lines if _line_matches(l, teg_lines))
    return matched / len(diff_lines)


def annotate_ai_edits(
    git_events: list[dict], tegs: list[dict], workspace_root: str
) -> dict:
    """Cross-reference git commits with textEditGroup entries."""
    MATCH_WINDOW_S = 300  # 5 minutes
    HIGH_THRESH = 0.5
    LOW_THRESH = 0.1

    teg_by_file: dict[str, list[dict]] = {}
    for teg in tegs:
        rel = teg["full_path"]
        if workspace_root and rel.startswith(workspace_root):
            rel = rel[len(workspace_root):]
        teg_by_file.setdefault(rel, []).append(teg)

    stats = {"matched": 0, "unmatched": 0, "total_tegs": len(tegs)}

    for evt in git_events:
        if evt["type"] != "git_commit":
            continue
        commit_epoch = evt["epoch"]
        diff_text = evt.get("diff", "")

        for cf in evt.get("changed_files", []):
            fpath = cf["path"]
            file_tegs = teg_by_file.get(fpath, [])
            if not file_tegs:
                stats["unmatched"] += 1
                continue

            diff_added = _diff_added_text(diff_text, fpath)

            candidates = []
            for teg in file_tegs:
                delta = commit_epoch - teg["epoch"]
                if -30 <= delta <= MATCH_WINDOW_S:
                    teg_content = _teg_text(teg)
                    score = _exact_match_score(diff_added, teg_content)
                    candidates.append((teg, delta, score))

            good = [c for c in candidates if c[2] >= LOW_THRESH]

            if good:
                good.sort(key=lambda c: (-c[2], abs(c[1])))
                best_teg, best_delta, best_score = good[0]

                all_edits = []
                for teg, delta, score in good:
                    if teg["epoch"] == best_teg["epoch"]:
                        all_edits.extend(teg["edits"])

                confidence = "high" if best_score >= HIGH_THRESH else "low"
                cf["ai_attributed"] = True
                cf["ai_info"] = {
                    "delta_seconds": round(best_delta),
                    "match_score": round(best_score, 2),
                    "confidence": confidence,
                    "prompt": best_teg["prompt"],
                    "edits": all_edits,
                    "teg_timestamp": best_teg["timestamp"],
                }
                stats["matched"] += 1
            else:
                stats["unmatched"] += 1

    return stats


def _has_merge_conflict_markers(added_text: str) -> bool:
    """Check if added text contains git merge conflict markers."""
    for line in added_text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("<<<<<<<") or stripped.startswith(">>>>>>>") \
                or stripped == "=======":
            return True
    return False


def _diff_removed_text(diff_text: str, fpath: str) -> str:
    """Extract the raw removed text from a unified diff for a specific file."""
    lines = diff_text.split("\n") if diff_text else []
    in_file = False
    removed_parts = []
    for line in lines:
        if line.startswith("diff --git"):
            in_file = line.endswith(f"b/{fpath}")
        elif in_file and line.startswith("-") and not line.startswith("---"):
            removed_parts.append(line[1:])
    return "\n".join(removed_parts)


def _net_new_chars(added_text: str, removed_text: str) -> int:
    """Count truly new characters in added_text that don't come from removed_text.

    Uses SequenceMatcher to find character-level overlap between added and
    removed text. Subtracts matched characters from the added total so that
    small edits to a long line (e.g. inserting a sentence into a paragraph)
    are not counted as entirely new content.
    """
    if not removed_text:
        return len(added_text)
    from difflib import SequenceMatcher
    sm = SequenceMatcher(None, removed_text, added_text, autojunk=False)
    matched_chars = sum(block.size for block in sm.get_matching_blocks())
    return len(added_text) - matched_chars


def annotate_likely_other_ai(events: list[dict]) -> int:
    """Flag non-AI-attributed edits as likely_external.

    Two independent checks — either one triggers the flag:
    1. net_new > size threshold (200 for code, 500 for docs/config/other)
    2. net_new / gap_seconds > 8.3 chars/sec (~100 WPM)

    For initial commits (no prior timing), only check 1 applies.
    Excludes diffs containing git merge conflict markers.
    """
    SIZE_THRESHOLD_CODE = 200   # code files: flag if net new > 200
    SIZE_THRESHOLD_OTHER = 500  # docs/config/other: flag if net new > 500
    MAX_TYPING_CPS = 500 / 60  # ~8.3 chars per second (~100 WPM)
    count = 0

    prev_epoch = None
    for evt in events:
        cur_epoch = evt.get("epoch", 0)

        if evt.get("type") != "git_commit":
            prev_epoch = cur_epoch
            continue

        diff_text = evt.get("diff", "")
        gap = (cur_epoch - prev_epoch) if prev_epoch else float("inf")
        if gap < 1:
            gap = 1  # avoid division by zero

        for cf in evt.get("changed_files", []):
            if cf.get("ai_attributed"):
                continue  # already matched to Copilot TEG

            fpath = cf.get("path", "")
            added_text = _diff_added_text(diff_text, fpath)
            if _has_merge_conflict_markers(added_text):
                continue

            removed_text = _diff_removed_text(diff_text, fpath)
            net_new = _net_new_chars(added_text, removed_text)

            ft = cf.get("file_type", "other")
            size_threshold = SIZE_THRESHOLD_CODE if ft == "code" else SIZE_THRESHOLD_OTHER
            is_initial = prev_epoch is None or evt.get("message", "").startswith("Initial Shadow Repo")
            too_large = net_new > size_threshold
            too_fast = not is_initial and (net_new / gap) > MAX_TYPING_CPS
            if too_large or too_fast:
                cf["likely_external"] = True
                cf["added_chars"] = net_new
                count += 1

        prev_epoch = cur_epoch

    return count


# ---------------------------------------------------------------------------
# LLM-based behavior classification
# ---------------------------------------------------------------------------

_BEHAVIOR_CODEBOOK = {
    "ai_breakdown_intent": ("Plan", "Decompose a complex goal into smaller pieces"),
    "ai_improve_prompt": ("Plan", "Refine the wording of a prompt for clarity and specificity"),
    "ai_suggest_steps_or_plan": ("Plan", "Provide a step-by-step workflow or plan"),
    "ai_choose_approach": ("Plan", "Choose a library, technology, or design approach"),
    "ai_generate_code": ("Code", "Produce code that implements a requested action"),
    "ai_edit_partial_code": ("Code", "Edit a specific snippet or function rather than rewriting the whole thing"),
    "ai_write_documentation": ("Code", "Write or edit documentation, READMEs, reports, or text content"),
    "ai_explain_bug_or_error": ("Explain", "Explain an error or traceback and outline a concrete fix"),
    "ai_explain_code_or_api": ("Explain", "Interpret code or explain what a function/API does"),
    "ai_explain_concepts": ("Explain", "Provide explanations of concepts"),
    "ai_understand_codebase": ("Explain", "Navigate, locate files, or understand project structure"),
    "ai_critique_output": ("Eval", "Evaluate results for correctness, alignment with goals, suggest improvements"),
    "ai_setup_environment": ("Setup", "Configure dev environment, install dependencies, manage build tools"),
    "ai_git_operations": ("Setup", "Git commands, version control, branching, merging"),
    "ai_run_or_deploy": ("Setup", "Run tests, start servers, deploy, or manage processes"),
    "ai_acknowledge": ("Converse", "Acknowledge, confirm, greet, or provide non-task conversational input"),
    "ai_provide_context": ("Converse", "Share logs, terminal output, or context for the AI to use"),
}

_OTHER_TO_CATEGORY = {
    # Setup
    "git_operations": "Setup", "configure_environment": "Setup",
    "dev_server_operations": "Setup", "run_tests": "Setup",
    "build_or_tooling": "Setup", "build_tooling": "Setup",
    "dev_environment_operations": "Setup", "debug_environment": "Setup",
    "process_management": "Setup", "credential_management": "Setup",
    "verify_deployment_state": "Setup", "testing_request": "Setup",
    "testing_logging_or_instrumentation": "Setup",
    "run_logs_status": "Setup", "troubleshoot_authentication": "Setup",
    "troubleshoot_login": "Setup",
    "version_control_rollback": "Setup", "version_control_scope_check": "Setup",
    "version_control_verify_state": "Setup", "version_control_compare_branches": "Setup",
    # Converse
    "acknowledgement": "Converse", "acknowledgment": "Converse",
    "affirmation": "Converse", "confirmation": "Converse",
    "chitchat": "Converse", "greeting": "Converse",
    "smalltalk_check": "Converse", "smalltalk_status": "Converse",
    "non_request": "Converse", "non_actionable": "Converse",
    "conversation": "Converse", "conversation_ack": "Converse",
    "conversation_state": "Converse", "meta_chat": "Converse",
    "meta_instruction": "Converse", "decline_help": "Converse",
    "unclear_acknowledgement": "Converse", "unclear_context": "Converse",
    "unclear_request": "Converse", "unclear_followup": "Converse",
    "unclear_or_incomplete": "Converse", "unclear_reference": "Converse",
    "provide_context": "Converse", "provide_logs": "Converse",
    "provide_install_logs": "Converse", "provide_requirement": "Converse",
    "provide_requirements": "Converse", "provide_files": "Converse",
    "provide_requested_info": "Converse", "share_terminal_output": "Converse",
    "share_image": "Converse", "clarify_context_with_code": "Converse",
    "clarify_changes": "Converse", "status_update": "Converse",
    "progress_summary": "Converse", "project_status_context": "Converse",
    "reset_context": "Converse", "confirm_no_changes": "Converse",
    "chat_ui_help": "Converse", "memory_request": "Converse",
    # Code
    "documentation_update": "Code", "documentation_writing": "Code",
    "write_documentation": "Code", "documentation": "Code",
    "documentation_editing": "Code", "documentation_edit": "Code",
    "generate_documentation": "Code", "resume_writing": "Code",
    "translation": "Code",
    # Explain
    "project_structure": "Explain", "project_file_inspection": "Explain",
    "navigate_project_structure": "Explain", "navigate_codebase": "Explain",
    "project_navigation": "Explain", "codebase_comprehension": "Explain",
    "codebase_search": "Explain", "locate_file": "Explain",
    "locate_files": "Explain", "locate_or_open_file": "Explain",
    "locate_file_or_project_structure": "Explain",
    "code_context_no_question": "Explain", "diff_repositories": "Explain",
    "configuration_question": "Explain",
    # Plan
    "choose_library_or_stack": "Plan", "choose_technology_provider": "Plan",
    "choose_model": "Plan", "select_provider": "Plan",
    "framework_request": "Plan", "decision": "Plan",
    "project_planning_priorities": "Plan",
    "project_requirements_or_priorities": "Plan",
    # Eval
    "code_review_prep": "Eval", "request_review_or_check": "Eval",
    "security_audit": "Eval",
}


def _behavior_category(code):
    if code in _BEHAVIOR_CODEBOOK:
        return _BEHAVIOR_CODEBOOK[code][0]
    if code.startswith("other:"):
        short = code[6:]
        return _OTHER_TO_CATEGORY.get(short, "Other")
    return "Other"


def enrich_chat_behaviors(events, cache_dir=None, batch_size=20):
    """Classify chat_prompt events with behavior codes and specificity scores.

    Adds ``behavior``, ``behavior_category``, and ``specificity`` fields
    to each chat_prompt event in-place.  Uses GPT-5.2 via the OpenAI SDK
    with per-prompt caching so re-runs are nearly instant.
    """
    import openai
    from tqdm import tqdm

    # Collect chat_prompt indices
    prompt_indices = [i for i, e in enumerate(events) if e.get("type") == "chat_prompt"]
    if not prompt_indices:
        return

    # Load cache
    cache = {}
    cache_file = None
    if cache_dir:
        Path(cache_dir).mkdir(parents=True, exist_ok=True)
        cache_file = Path(cache_dir) / "behavior_cache.json"
        if cache_file.is_file():
            cache = json.loads(cache_file.read_text())
            print(f"  Loaded {len(cache)} cached behavior labels")

    # Identify uncached prompts
    hashes = {}
    uncached = []
    for idx in prompt_indices:
        text = events[idx].get("prompt", "")
        h = hashlib.sha256(text.encode()).hexdigest()[:16]
        hashes[idx] = h
        if h not in cache:
            uncached.append(idx)

    if not uncached:
        print("  All prompts already cached")
    else:
        print(f"  Classifying {len(uncached)} prompts ({len(prompt_indices) - len(uncached)} cached)...")

        codebook_lines = []
        for code, (cat, desc) in _BEHAVIOR_CODEBOOK.items():
            codebook_lines.append(f"- {code} [{cat}]: {desc}")

        system_msg = (
            "You classify student prompts sent to AI coding assistants.\n\n"
            "BEHAVIOR CODEBOOK:\n" + "\n".join(codebook_lines) + "\n\n"
            "If a prompt does not fit any category, use \"other:short_label\" "
            "(e.g., \"other:configure_environment\", \"other:git_operations\").\n\n"
            "SPECIFICITY SCALE (1-5):\n"
            "1 = Very vague: no context (e.g., \"help\", \"fix this\")\n"
            "2 = Vague: mentions a topic but lacks detail (e.g., \"the function doesn't work\")\n"
            "3 = Moderate: states the problem with some context (e.g., \"error when running tests\")\n"
            "4 = Specific: includes file names, error messages, expected behavior\n"
            "5 = Very specific: includes code snippets, exact error output, clear expected vs actual\n\n"
            "For each prompt return a JSON object with \"b\" (behavior code) and \"s\" (specificity 1-5).\n"
            "Reply with ONLY a JSON array, one object per prompt, in order.\n"
            "Example: [{\"b\":\"ai_generate_code\",\"s\":3},{\"b\":\"other:git_operations\",\"s\":2}]"
        )

        client = openai.OpenAI()
        batches = [uncached[i:i + batch_size] for i in range(0, len(uncached), batch_size)]

        for batch_num, batch_indices in enumerate(tqdm(batches, desc="  Classifying")):
            lines = []
            for seq, idx in enumerate(batch_indices):
                text = events[idx].get("prompt", "")[:500].replace("\n", " ").strip()
                lines.append(f"{seq + 1}. {text}")

            user_msg = "Classify each prompt:\n\n" + "\n".join(lines)

            for attempt in range(2):
                try:
                    resp = client.chat.completions.create(
                        model="gpt-5.2",
                        messages=[
                            {"role": "developer", "content": system_msg},
                            {"role": "user", "content": user_msg},
                        ],
                        max_completion_tokens=2048,
                        reasoning_effort="low",
                    )
                    raw = resp.choices[0].message.content.strip()
                    if "```" in raw:
                        raw = raw.split("```")[1]
                        if raw.startswith("json"):
                            raw = raw[4:]
                    results = json.loads(raw)
                    if len(results) == len(batch_indices):
                        for j, idx in enumerate(batch_indices):
                            r = results[j]
                            cache[hashes[idx]] = {
                                "b": r.get("b", "unknown"),
                                "s": max(1, min(5, int(r.get("s", 3)))),
                            }
                        break
                    else:
                        print(f"\n  Batch {batch_num}: got {len(results)} for {len(batch_indices)}, retrying...")
                except Exception as e:
                    if attempt == 0:
                        print(f"\n  Batch {batch_num} failed ({e}), retrying...")
                    else:
                        print(f"\n  Batch {batch_num} failed twice, marking as unknown")
                        for idx in batch_indices:
                            cache[hashes[idx]] = {"b": "unknown", "s": 3}

            # Save cache every 10 batches
            if cache_file and batch_num % 10 == 9:
                cache_file.write_text(json.dumps(cache, ensure_ascii=False))

            time.sleep(0.3)

        if cache_file:
            cache_file.write_text(json.dumps(cache, ensure_ascii=False))
            print(f"  Saved {len(cache)} behavior labels to cache")

    # Apply to events
    for idx in prompt_indices:
        entry = cache.get(hashes[idx], {"b": "unknown", "s": 3})
        events[idx]["behavior"] = entry["b"]
        events[idx]["behavior_category"] = _behavior_category(entry["b"])
        events[idx]["specificity"] = entry["s"]


# ---------------------------------------------------------------------------
# Timeline assembly
# ---------------------------------------------------------------------------

def build_timeline(student_dir: Path) -> dict:
    """Build a unified timeline from a filtered student directory."""
    git_events = []
    chat_events = []

    # Shadow git
    shadow_git = student_dir / "shadow_git_repo"
    if shadow_git.is_dir():
        print(f"Extracting git commits from {shadow_git}...")
        git_events = extract_git_events(shadow_git)
        print(f"  Found {len(git_events)} commits")

    # Chat sessions
    chat_dir = student_dir / "chat_sessions"
    if chat_dir.is_dir():
        print(f"Extracting enriched chat events from {chat_dir}...")
        chat_events = extract_chat_events(chat_dir)
        n_prompts = sum(1 for e in chat_events if e["type"] == "chat_prompt")
        n_actions = sum(1 for e in chat_events if e["type"] == "chat_action")
        print(f"  Found {n_prompts} prompts, {n_actions} actions")

    # AI edit attribution
    tegs = []
    if chat_dir.is_dir():
        print(f"Extracting textEditGroups for AI attribution...")
        tegs = extract_text_edit_groups(chat_dir)
        print(f"  Found {len(tegs)} textEditGroup entries")

    if tegs and git_events:
        git_file_set = set()
        for evt in git_events:
            for cf in evt.get("changed_files", []):
                git_file_set.add(cf["path"])
        workspace_root = extract_workspace_root(tegs, git_file_set)
        print(f"  Workspace root: {workspace_root or '(unknown)'}")
        ai_stats = annotate_ai_edits(git_events, tegs, workspace_root)
        print(f"  AI-attributed file edits: {ai_stats['matched']}, "
              f"human/unmatched: {ai_stats['unmatched']}")

    # Merge and sort by epoch
    all_events = git_events + chat_events
    all_events.sort(key=lambda e: e["epoch"])

    # Flag likely other AI edits (needs sorted events for gap calculation)
    n_likely = annotate_likely_other_ai(all_events)
    if n_likely:
        print(f"  Likely other AI edits: {n_likely}")

    n_prompts = sum(1 for e in all_events if e["type"] == "chat_prompt")
    n_actions = sum(1 for e in all_events if e["type"] == "chat_action")

    # Build file tree from the latest git state
    file_tree = []
    if shadow_git.is_dir():
        result = subprocess.run(
            ["git", "-C", str(shadow_git), "ls-files"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0:
            file_tree = sorted(result.stdout.strip().split("\n"))

    return {
        "student_hash": student_dir.name,
        "total_events": len(all_events),
        "git_commits": len(git_events),
        "chat_prompts": n_prompts,
        "chat_actions": n_actions,
        "file_tree": file_tree,
        "events": all_events,
    }
