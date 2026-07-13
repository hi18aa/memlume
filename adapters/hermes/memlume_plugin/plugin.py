"""將 Hermes General Plugin hook 轉送到 Memlume Adapter SDK。"""

from __future__ import annotations

from collections import OrderedDict
import json
import os
from pathlib import Path
import subprocess
import threading
from typing import Any, Callable, Mapping
from uuid import uuid4


BridgeRunner = Callable[[dict[str, Any], float], Any]
COMPLETED_SESSION_LIMIT = 256


class MemlumePlugin:
    def __init__(
        self,
        *,
        environment: Mapping[str, str] | None = None,
        runner: BridgeRunner | None = None,
        timeout_seconds: float = 0.5,
    ) -> None:
        self._environment = dict(os.environ if environment is None else environment)
        self._runner = runner or _SubprocessBridge(self._environment)
        self._timeout_seconds = timeout_seconds
        self._turns: dict[str, str] = {}
        self._finished_sessions: OrderedDict[str, None] = OrderedDict()
        self._last_envelope: dict[str, str] | None = None
        self._lock = threading.Lock()

    def pre_llm_call(self, *, session_id: str, user_message: str, **_kwargs: Any) -> dict[str, str] | None:
        envelope = self._envelope(session_id)
        if envelope is None or not isinstance(user_message, str) or user_message.strip() == "":
            return None

        message_id = f"hermes-{uuid4()}"
        with self._lock:
            self._turns[session_id] = message_id
            self._finished_sessions.pop(session_id, None)
            self._last_envelope = envelope

        scope = {"level": "project", "projectId": envelope["projectId"]}
        self._background({
            "operation": "onUserMessage",
            "envelope": envelope,
            "message": {"messageId": message_id, "content": user_message, "brainId": self._environment["MEMLUME_BRAIN_ID"], "scope": scope},
        })
        context = self._invoke({
            "operation": "beforeTask",
            "input": {"envelope": envelope, "intent": "shared_memory", "scope": scope, "task": None, "contextBudget": 600},
        }, self._timeout_seconds)
        return _ephemeral_context(context)

    def post_llm_call(self, *, session_id: str, assistant_response: str, **_kwargs: Any) -> None:
        envelope = self._envelope(session_id)
        if envelope is None or not isinstance(assistant_response, str) or assistant_response.strip() == "":
            return None
        with self._lock:
            message_id = self._turns.get(session_id)
        if message_id is None:
            return None
        self._background({
            "operation": "afterTask",
            "envelope": envelope,
            "message": {"messageId": message_id, "content": assistant_response, "brainId": self._environment["MEMLUME_BRAIN_ID"]},
        })
        return None

    def on_session_end(self, *, session_id: str | None, **_kwargs: Any) -> None:
        envelope = self._envelope(session_id)
        if envelope is None:
            return None
        return self._finish_session(envelope)

    def on_session_finalize(self, *, session_id: str | None, **kwargs: Any) -> None:
        if isinstance(session_id, str) and session_id.strip() != "":
            return self.on_session_end(session_id=session_id, **kwargs)
        with self._lock:
            envelope = self._last_envelope
        return None if envelope is None else self._finish_session(envelope)

    def _finish_session(self, envelope: dict[str, str]) -> None:
        session_id = envelope["sessionId"]
        with self._lock:
            if session_id in self._finished_sessions:
                return None
            self._finished_sessions[session_id] = None
            while len(self._finished_sessions) > COMPLETED_SESSION_LIMIT:
                self._finished_sessions.popitem(last=False)
            self._turns.pop(session_id, None)
        scope = {"level": "project", "projectId": envelope["projectId"]}
        self._background({
            "operation": "onSessionEnd",
            # 新 bridge process 需先以同一 envelope 綁定 SDK outbox，才能重送既有資料。
            "input": {"envelope": envelope, "intent": "shared_memory", "scope": scope, "task": None, "contextBudget": 0},
        })
        return None

    def _envelope(self, session_id: str | None) -> dict[str, str] | None:
        required = ("MEMLUME_INSTALLATION_ID", "MEMLUME_PROFILE_ID", "MEMLUME_PROJECT_ID", "MEMLUME_BRAIN_ID")
        if not isinstance(session_id, str) or session_id.strip() == "" or any(self._environment.get(key, "").strip() == "" for key in required):
            return None
        envelope = {
            "clientType": "hermes",
            "installationId": self._environment["MEMLUME_INSTALLATION_ID"],
            "profileId": self._environment["MEMLUME_PROFILE_ID"],
            "sessionId": session_id,
            "projectId": self._environment["MEMLUME_PROJECT_ID"],
        }
        workspace_path = self._environment.get("MEMLUME_WORKSPACE_PATH", "").strip()
        if workspace_path:
            envelope["workspacePath"] = workspace_path
        return envelope

    def _background(self, payload: dict[str, Any]) -> None:
        threading.Thread(target=self._invoke, args=(payload, 11.0), daemon=True).start()

    def _invoke(self, payload: dict[str, Any], timeout: float) -> Any:
        try:
            return self._runner(payload, timeout)
        except Exception:
            return None


class _SubprocessBridge:
    def __init__(self, environment: Mapping[str, str]) -> None:
        self._environment = dict(environment)

    def __call__(self, payload: dict[str, Any], timeout: float) -> Any:
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
    for item in context.get("procedures", []):
        if isinstance(item, dict) and isinstance(item.get("steps"), list):
            lines.extend(step.strip() for step in item["steps"] if isinstance(step, str) and step.strip())
    if not lines:
        return None
    return {"context": "Memlume shared context:\n" + "\n".join(f"- {line}" for line in lines)}


def register(ctx: Any) -> MemlumePlugin:
    plugin = MemlumePlugin()
    for hook in ("pre_llm_call", "post_llm_call", "on_session_end", "on_session_finalize"):
        ctx.register_hook(hook, getattr(plugin, hook))
    return plugin
