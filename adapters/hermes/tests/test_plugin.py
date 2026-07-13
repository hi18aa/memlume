import importlib
import os
from pathlib import Path
import sys
import threading
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

    def test_post_and_finalization_use_recorded_turn_and_flush_once(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        calls = []
        completed = threading.Event()

        def runner(payload, _timeout):
            calls.append(payload)
            if payload["operation"] == "beforeTask":
                return {}
            if payload["operation"] == "onSessionEnd":
                completed.set()
            return {"status": "saved"}

        plugin = plugin_module.MemlumePlugin(environment=self.environment, runner=runner, timeout_seconds=0.2)
        plugin.pre_llm_call(session_id="hermes-session", user_message="記住專案使用 pnpm")
        plugin.post_llm_call(session_id="hermes-session", assistant_response="已記住。")
        plugin.on_session_end(session_id="hermes-session")
        plugin.on_session_finalize(session_id="hermes-session")

        self.assertTrue(completed.wait(0.3))
        audit = next(call for call in calls if call["operation"] == "afterTask")
        capture = next(call for call in calls if call["operation"] == "onUserMessage")
        self.assertEqual(audit["message"]["messageId"], capture["message"]["messageId"])
        self.assertEqual(audit["message"]["content"], "已記住。")
        self.assertEqual(len([call for call in calls if call["operation"] == "onSessionEnd"]), 1)

    def test_finalization_without_session_flushes_last_envelope_once_and_bounds_completed_sessions(self):
        plugin_module = importlib.import_module("memlume_plugin.plugin")
        calls = []
        flushed = threading.Event()

        def runner(payload, _timeout):
            calls.append(payload)
            if payload["operation"] == "onSessionEnd":
                flushed.set()
            return {}

        plugin = plugin_module.MemlumePlugin(environment=self.environment, runner=runner)
        plugin.pre_llm_call(session_id="finalize-session", user_message="記住專案使用 pnpm")
        plugin.on_session_finalize(session_id=None)

        self.assertTrue(flushed.wait(0.3))
        session_end = [call for call in calls if call["operation"] == "onSessionEnd"]
        self.assertEqual(len(session_end), 1)
        self.assertEqual(session_end[0]["input"]["envelope"]["sessionId"], "finalize-session")
        plugin.on_session_end(session_id="finalize-session")
        self.assertEqual(len([call for call in calls if call["operation"] == "onSessionEnd"]), 1)

        for index in range(257):
            plugin.on_session_end(session_id=f"finished-{index}")
        self.assertLessEqual(len(plugin._finished_sessions), 256)

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

        self.assertEqual(set(context.hooks), {"pre_llm_call", "post_llm_call", "on_session_end", "on_session_finalize"})
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


if __name__ == "__main__":
    unittest.main()
