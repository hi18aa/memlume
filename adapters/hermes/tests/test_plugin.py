import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest


ADAPTER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADAPTER_ROOT))


class HermesPluginTests(unittest.TestCase):
    def setUp(self):
        self.environment = {
            "MEMLUME_TOKEN": "adapter-token-not-for-payloads",
            "MEMLUME_INSTALLATION_ID": "00000000-0000-7000-8000-000000000010",
            "MEMLUME_PROFILE_ID": "00000000-0000-7000-8000-000000000011",
            "MEMLUME_PROJECT_ID": "00000000-0000-7000-8000-000000000012",
            "MEMLUME_BRAIN_ID": "00000000-0000-7000-8000-000000000013",
            "MEMLUME_WORKSPACE_PATH": "C:/work/memlume",
        }

    def test_pre_llm_captures_project_message_and_injects_only_ephemeral_context(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        calls = []
        capture_seen = threading.Event()

        def runner(payload, _timeout):
            calls.append(payload)
            if payload["operation"] == "onUserMessage":
                capture_seen.set()
                return {"status": "saved", "memoryStatus": "active"}
            if payload["operation"] == "beforeTask":
                return {"directives": [{"text": "專案套件管理器使用 pnpm。"}], "preferences": []}
            return []

        plugin = plugin_module.MemlumePlugin(environment=self.environment, runner=runner, timeout_seconds=0.2)
        injected = plugin.pre_llm_call(session_id="hermes-session", user_message="記住專案使用 pnpm")

        self.assertTrue(capture_seen.wait(0.2))
        self.assertEqual(injected, {"context": "Memlume shared context:\n- 專案套件管理器使用 pnpm。"})
        capture = next(call for call in calls if call["operation"] == "onUserMessage")
        self.assertEqual(capture["envelope"], {
            "clientType": "hermes",
            "installationId": self.environment["MEMLUME_INSTALLATION_ID"],
            "profileId": self.environment["MEMLUME_PROFILE_ID"],
            "sessionId": "hermes-session",
            "projectId": self.environment["MEMLUME_PROJECT_ID"],
            "workspacePath": self.environment["MEMLUME_WORKSPACE_PATH"],
        })
        self.assertEqual(capture["message"]["content"], "記住專案使用 pnpm")
        self.assertEqual(capture["message"]["brainId"], self.environment["MEMLUME_BRAIN_ID"])
        self.assertEqual(capture["message"]["scope"], {"level": "project", "projectId": self.environment["MEMLUME_PROJECT_ID"]})
        self.assertNotIn(self.environment["MEMLUME_TOKEN"], repr(calls))

    def test_subagent_observer_defers_restricted_context_until_the_child_first_prompt(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        calls = []

        def runner(payload, _timeout):
            calls.append(payload)
            return {"directives": [{"text": "只給 child 的專案內容。"}]}

        plugin = plugin_module.MemlumePlugin(environment=self.environment, runner=runner, timeout_seconds=0.2)
        plugin.subagent_start(
            parent_turn_id="parent-turn",
            child_session_id="child-session",
            child_subagent_id="child-1",
            child_goal="Research the adapter.",
        )
        self.assertEqual(calls, [])

        injected = plugin.pre_llm_call(session_id="child-session", user_message="請研究子代理路由。")

        self.assertEqual(injected, {"context": "Memlume shared context:\n- 只給 child 的專案內容。"})
        self.assertEqual(calls, [{
            "operation": "onSubagentStart",
            "input": {
                "envelope": {
                    "clientType": "hermes",
                    "installationId": self.environment["MEMLUME_INSTALLATION_ID"],
                    "profileId": self.environment["MEMLUME_PROFILE_ID"],
                    "sessionId": "child-session",
                    "projectId": self.environment["MEMLUME_PROJECT_ID"],
                    "workspacePath": self.environment["MEMLUME_WORKSPACE_PATH"],
                },
                "parentTaskId": "parent-turn",
                "subagentId": "child-1",
                "intent": "shared_memory",
                "scope": {"level": "project", "projectId": self.environment["MEMLUME_PROJECT_ID"]},
                "task": "Research the adapter.",
                "contextBudget": 600,
                "requestedBrainIds": [self.environment["MEMLUME_BRAIN_ID"]],
            },
        }])
        self.assertNotIn(self.environment["MEMLUME_TOKEN"], repr(calls))

        for index in range(257):
            plugin.subagent_start(parent_turn_id=f"parent-{index}", child_session_id=f"child-{index}")
        self.assertLessEqual(len(plugin._child_sessions), 256)


    def test_pre_timeout_keeps_bridge_running_without_a_kill_timeout(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        calls = []
        started = threading.Event()
        release = threading.Event()
        completed = threading.Event()

        def runner(payload, timeout):
            calls.append((payload, timeout))
            if payload["operation"] == "beforeTask":
                started.set()
                release.wait(1)
                completed.set()
                return {"directives": [{"text": "稍後完成的共享內容。"}]}
            return {}

        plugin = plugin_module.MemlumePlugin(environment=self.environment, runner=runner, timeout_seconds=0.01)
        started_at = time.monotonic()
        self.assertIsNone(plugin.pre_llm_call(session_id="slow-context", user_message="記住專案使用 pnpm"))
        self.assertLess(time.monotonic() - started_at, 0.2)
        self.assertTrue(started.is_set())
        self.assertIsNone(next(timeout for payload, timeout in calls if payload["operation"] == "beforeTask"))

        release.set()
        self.assertTrue(completed.wait(0.3))

    def test_registers_general_plugin_hooks_without_touching_memory_provider(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        existing_provider = object()

        class Context:
            def __init__(self):
                self.hooks = {}
                self.memory_provider = existing_provider

            def register_hook(self, name, callback):
                self.hooks[name] = callback

        context = Context()
        plugin_module.register(context)

        self.assertEqual(set(context.hooks), {"pre_llm_call", "subagent_start"})
        self.assertIs(context.memory_provider, existing_provider)
        manifest = (ADAPTER_ROOT / "plugin.yaml").read_text(encoding="utf-8")
        self.assertNotIn("memory_provider", manifest.lower())
        self.assertNotIn("memoryprovider", (ADAPTER_ROOT / "memlume_plugin" / "plugin.py").read_text(encoding="utf-8").lower())

    def test_missing_configuration_or_bridge_failure_is_fail_open(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        calls = []

        def failing_runner(payload, _timeout):
            calls.append(payload)
            raise RuntimeError("bridge unavailable")

        plugin = plugin_module.MemlumePlugin(environment=self.environment, runner=failing_runner, timeout_seconds=0.01)
        self.assertIsNone(plugin.pre_llm_call(session_id="hermes-session", user_message="記住專案使用 pnpm"))
        self.assertGreaterEqual(len(calls), 1)

        before_unconfigured = len(calls)
        unconfigured = plugin_module.MemlumePlugin(environment={}, runner=failing_runner)
        self.assertIsNone(unconfigured.pre_llm_call(session_id="hermes-session", user_message="任何訊息"))
        self.assertEqual(len(calls), before_unconfigured)

    def test_loads_a_hermes_profile_when_host_environment_is_not_configured(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        calls = []
        captured = threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            config_path.write_text(json.dumps({
                "version": 1,
                "backupDirectory": str(Path(directory) / "backups"),
                "adapters": [{
                    "clientType": "hermes",
                    "installationId": "hermes-main",
                    "profileId": "default",
                    "projectId": "memlume",
                    "brainId": "00000000-0000-7000-8000-000000000013",
                    "token": "hermes-profile-token",
                    "corePath": "C:/work/memlume",
                    "daemonUrl": "http://127.0.0.1:3849",
                }],
            }), encoding="utf-8")

            def runner(payload, _timeout):
                calls.append(payload)
                if payload["operation"] == "onUserMessage":
                    captured.set()
                return {}

            plugin = plugin_module.MemlumePlugin(environment={"MEMLUME_CONFIG_PATH": str(config_path)}, runner=runner)
            plugin.pre_llm_call(session_id="hermes-session", user_message="記住專案使用 pnpm")

        self.assertTrue(captured.wait(0.3))
        capture = next(call for call in calls if call["operation"] == "onUserMessage")
        self.assertEqual(capture["envelope"], {
            "clientType": "hermes",
            "installationId": "hermes-main",
            "profileId": "default",
            "sessionId": "hermes-session",
            "projectId": "memlume",
        })
        self.assertEqual(capture["message"]["brainId"], "00000000-0000-7000-8000-000000000013")
        self.assertNotIn("hermes-profile-token", repr(calls))


if __name__ == "__main__":
    unittest.main()
