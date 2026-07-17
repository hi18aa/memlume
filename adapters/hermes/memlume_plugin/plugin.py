"""將 Hermes General Plugin hook 轉送到 Memlume Adapter SDK。"""

from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
from typing import Any, Callable, Mapping


BridgeRunner = Callable[[dict[str, Any], float | None], Any]
CHILD_SESSION_LIMIT = 256
# Hermes must continue its turn even when the local bridge or daemon is slow.
# The SDK owns the shorter 250 ms context request deadline; this host-level
# guard leaves a deterministic 500 ms fail-open ceiling for future bridge work.
DEFAULT_TIMEOUT_SECONDS = 0.5


class MemlumePlugin:
    def __init__(
        self,
        *,
        environment: Mapping[str, str] | None = None,
        runner: BridgeRunner | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._environment = _with_local_profile(dict(os.environ if environment is None else environment))
        self._runner = runner or _SubprocessBridge(self._environment)
        self._timeout_seconds = timeout_seconds
        self._child_sessions: OrderedDict[str, dict[str, str | bool | None]] = OrderedDict()
        self._lock = threading.Lock()

    def pre_llm_call(self, *, session_id: str, user_message: str, **_kwargs: Any) -> dict[str, str] | None:
        envelope = self._envelope(session_id)
        if envelope is None or not isinstance(user_message, str) or user_message.strip() == "":
            return None

        is_child, child_context = self._child_context(session_id, envelope, user_message)
        if is_child:
            return child_context

        message_id = f"hermes:{session_id}:{hashlib.sha256(user_message.encode('utf-8')).hexdigest()[:24]}"
        scope = ({"level": "project", "projectId": envelope["projectId"]}
                 if "projectId" in envelope else {"level": "global"})
        message: dict[str, Any] = {"messageId": message_id, "content": user_message, "turnId": message_id}
        if self._environment.get("MEMLUME_BRAIN_ID", "").strip():
            message["brainId"] = self._environment["MEMLUME_BRAIN_ID"]
        if envelope.get("projectId"):
            message["scope"] = scope
        self._background({
            "operation": "onUserMessage",
            "envelope": envelope,
            "message": message,
        })
        context = self._bounded_invoke({
            "operation": "beforeTask",
            "input": {"envelope": envelope, "intent": "shared_memory", "scope": scope, "task": user_message, "contextBudget": 600, "workspacePath": envelope.get("workspacePath"), "agentType": "hermes"},
        })
        return _ephemeral_context(context)

    def post_llm_call(self, *, session_id: str, assistant_response: str | None = None, turn_id: str | None = None, **kwargs: Any) -> None:
        """Retain only the bounded assistant final for a later user approval."""
        envelope = self._envelope(session_id)
        if envelope is None or "projectId" in envelope or "MEMLUME_BRAIN_ID" in self._environment:
            return None
        final_answer = _text(assistant_response) or _text(kwargs.get("assistant_response"))
        stable_turn_id = _text(turn_id) or _text(kwargs.get("turn_id"))
        if final_answer is None or stable_turn_id is None:
            return None
        self._bounded_invoke({
            "operation": "recordAssistantFinal",
            "envelope": envelope,
            "input": {"turnId": stable_turn_id, "finalAnswer": final_answer},
        })
        return None

    def subagent_start(
        self,
        *,
        parent_turn_id: str | None = None,
        child_session_id: str | None = None,
        child_subagent_id: str | None = None,
        child_goal: str | None = None,
        **kwargs: Any,
    ) -> None:
        session_id = _text(child_session_id) or _text(kwargs.get("child_session_key"))
        if session_id is None or self._envelope(session_id) is None:
            return None
        parent_task_id = _text(parent_turn_id) or _text(kwargs.get("parent_task_id")) or session_id
        with self._lock:
            self._child_sessions.pop(session_id, None)
            self._child_sessions[session_id] = {
                "parentTaskId": parent_task_id,
                "subagentId": _text(child_subagent_id) or _text(kwargs.get("subagent_id")),
                "task": _text(child_goal) or _text(kwargs.get("task")),
                "started": False,
            }
            while len(self._child_sessions) > CHILD_SESSION_LIMIT:
                self._child_sessions.popitem(last=False)
        return None

    def _child_context(self, session_id: str, envelope: dict[str, str], user_message: str) -> tuple[bool, dict[str, str] | None]:
        with self._lock:
            child = self._child_sessions.get(session_id)
            if child is None:
                return False, None
            if child["started"] is True:
                return True, None
            child["started"] = True

        scope = ({"level": "project", "projectId": envelope["projectId"]}
                 if "projectId" in envelope else {"level": "global"})
        task = child["task"] if isinstance(child["task"], str) else user_message
        input: dict[str, Any] = {
            "envelope": envelope,
            "parentTaskId": child["parentTaskId"],
            "intent": "shared_memory",
            "scope": scope,
            "task": task,
            "contextBudget": 600,
        }
        if self._environment.get("MEMLUME_BRAIN_ID", "").strip():
            input["requestedBrainIds"] = [self._environment["MEMLUME_BRAIN_ID"]]
        else:
            input["workspacePath"] = envelope.get("workspacePath")
            input["agentType"] = "hermes"
        if isinstance(child["subagentId"], str):
            input["subagentId"] = child["subagentId"]
        return True, _ephemeral_context(self._bounded_invoke({"operation": "onSubagentStart", "input": input}))

    def _envelope(self, session_id: str | None) -> dict[str, str] | None:
        required = ("MEMLUME_INSTALLATION_ID", "MEMLUME_PROFILE_ID")
        if not isinstance(session_id, str) or session_id.strip() == "" or any(self._environment.get(key, "").strip() == "" for key in required):
            return None
        envelope = {
            "clientType": "hermes",
            "installationId": self._environment["MEMLUME_INSTALLATION_ID"],
            "profileId": self._environment["MEMLUME_PROFILE_ID"],
            "sessionId": session_id,
        }
        project_id = self._environment.get("MEMLUME_PROJECT_ID", "").strip()
        if project_id:
            envelope["projectId"] = project_id
        workspace_path = self._environment.get("MEMLUME_WORKSPACE_PATH", "").strip()
        if workspace_path:
            envelope["workspacePath"] = workspace_path
        return envelope

    def _background(self, payload: dict[str, Any]) -> None:
        threading.Thread(target=self._invoke, args=(payload, None), daemon=True).start()

    def _bounded_invoke(self, payload: dict[str, Any]) -> Any:
        completed = threading.Event()
        result: list[Any] = [None]

        def run() -> None:
            try:
                result[0] = self._invoke(payload, None)
            finally:
                completed.set()

        threading.Thread(target=run, daemon=True).start()
        return result[0] if completed.wait(max(self._timeout_seconds, 0)) else None

    def _invoke(self, payload: dict[str, Any], timeout: float | None) -> Any:
        try:
            return self._runner(payload, timeout)
        except Exception:
            return None


class _SubprocessBridge:
    def __init__(self, environment: Mapping[str, str]) -> None:
        self._environment = dict(environment)

    def __call__(self, payload: dict[str, Any], timeout: float | None) -> Any:
        bridge = self._environment.get("MEMLUME_NODE_BRIDGE") or str(Path(__file__).resolve().parents[1] / "bridge.mjs")
        environment = os.environ.copy()
        environment.update(self._environment)
        try:
            completed = subprocess.run(
                [environment.get("MEMLUME_NODE_BINARY", "node"), bridge],
                input=json.dumps(payload, ensure_ascii=False) + "\n",
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=timeout,
                check=False,
                env=environment,
            )
            if completed.returncode != 0:
                return None
            response = json.loads(completed.stdout.strip())
            return response.get("result") if isinstance(response, dict) and response.get("ok") is True else None
        except (OSError, ValueError, subprocess.SubprocessError):
            return None


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _ephemeral_context(context: Any) -> dict[str, str] | None:
    if not isinstance(context, dict):
        return None
    lines: list[str] = []
    for key in ("directives", "preferences", "decisions"):
        for item in context.get(key, []):
            if isinstance(item, dict) and isinstance(item.get("text"), str) and item["text"].strip():
                lines.append(item["text"].strip())
    for item in context.get("knowledge", []):
        if isinstance(item, dict) and isinstance(item.get("summary"), str) and item["summary"].strip():
            lines.append(item["summary"].strip())
    for item in context.get("documents", []):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            continue
        path = _text(item.get("logicalPath"))
        heading = item.get("headingPath")
        heading_text = " > ".join(value.strip() for value in heading if isinstance(value, str) and value.strip()) if isinstance(heading, list) else ""
        if path is not None:
            lines.append(f"［{path}{('#' + heading_text) if heading_text else ''}］ {item['text'].strip()}")
    for item in context.get("procedures", []):
        if isinstance(item, dict) and isinstance(item.get("steps"), list):
            lines.extend(step.strip() for step in item["steps"] if isinstance(step, str) and step.strip())
    if not lines:
        return None
    return {"context": "Memlume shared context:\n" + "\n".join(f"- {line}" for line in lines)}


def register(ctx: Any) -> MemlumePlugin:
    plugin = MemlumePlugin()
    for hook in ("pre_llm_call", "subagent_start"):
        ctx.register_hook(hook, getattr(plugin, hook))
    # Hermes versions that advertise the post-call lifecycle can retain a
    # final response.  Older hosts keep the original two-hook contract.
    supports_hook = getattr(ctx, "supports_hook", None)
    if callable(supports_hook) and supports_hook("post_llm_call"):
        ctx.register_hook("post_llm_call", plugin.post_llm_call)
    return plugin


def _with_local_profile(environment: dict[str, str]) -> dict[str, str]:
    """以 CLI 管理的 profile 補足 Hermes 所需的本機設定，不輸出任何 secret。"""
    configured_path = environment.get("MEMLUME_CONFIG_PATH", "").strip()
    path = Path(configured_path) if configured_path else Path.home() / ".config" / "memlume" / "config.json"
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return environment
    profiles = parsed.get("adapters") if isinstance(parsed, dict) else None
    if not isinstance(profiles, list):
        return environment
    requested_installation = environment.get("MEMLUME_INSTALLATION_ID", "").strip()
    requested_profile = environment.get("MEMLUME_PROFILE_ID", "").strip()
    profile = next((candidate for candidate in profiles if _matches_profile(candidate, requested_installation, requested_profile)), None)
    if not isinstance(profile, dict):
        return environment
    fields = {
        "MEMLUME_INSTALLATION_ID": "installationId",
        "MEMLUME_PROFILE_ID": "profileId",
        "MEMLUME_PROJECT_ID": "projectId",
        "MEMLUME_BRAIN_ID": "brainId",
        "MEMLUME_TOKEN": "token",
        "MEMLUME_HOME": "corePath",
        "MEMLUME_DAEMON_URL": "daemonUrl",
        "MEMLUME_WORKSPACE_PATH": "workspacePath",
        "MEMLUME_OUTBOX_DIRECTORY": "outboxDirectory",
    }
    resolved = dict(environment)
    for destination, source in fields.items():
        current = resolved.get(destination, "").strip()
        value = profile.get(source)
        if not current and isinstance(value, str) and value.strip():
            resolved[destination] = value.strip()
    return resolved


def _matches_profile(candidate: Any, installation_id: str, profile_id: str) -> bool:
    return (
        isinstance(candidate, dict)
        and candidate.get("clientType") == "hermes"
        and isinstance(candidate.get("installationId"), str)
        and isinstance(candidate.get("profileId"), str)
        and (not installation_id or candidate["installationId"] == installation_id)
        and (not profile_id or candidate["profileId"] == profile_id)
    )
