"""Hermes directory-plugin loader contract tests."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest


ADAPTER_ROOT = Path(__file__).resolve().parents[1]


def _hermes_python() -> Path | None:
    candidates: list[Path] = []
    configured = os.environ.get("HERMES_PYTHON", "").strip()
    if configured:
        configured_path = Path(configured)
        if configured_path.is_file():
            candidates.append(configured_path)
        else:
            resolved = shutil.which(configured)
            if resolved:
                candidates.append(Path(resolved).resolve())
    hermes = shutil.which("hermes")
    if hermes:
        hermes_path = Path(hermes).resolve()
        candidates.append(hermes_path.with_name("python.exe"))
        candidates.append(hermes_path.with_name("python"))
    candidates.extend([
        Path.home() / "AppData" / "Local" / "hermes" / "hermes-agent" / "venv" / "Scripts" / "python.exe",
        Path.home() / ".local" / "share" / "hermes" / "hermes-agent" / "venv" / "bin" / "python",
    ])
    return next((candidate for candidate in candidates if candidate.is_file()), None)


class HermesDirectoryLoaderTests(unittest.TestCase):
    def test_directory_plugin_exposes_host_entrypoint(self):
        self.assertTrue((ADAPTER_ROOT / "plugin.yaml").is_file())
        self.assertTrue(
            (ADAPTER_ROOT / "__init__.py").is_file(),
            "Hermes directory plugins require a root __init__.py entrypoint.",
        )

    def test_real_hermes_loader_imports_and_registers_plugin(self):
        hermes_python = _hermes_python()
        if hermes_python is None:
            self.skipTest("Hermes runtime is not installed in this environment")

        script = r'''
import sys
from pathlib import Path

from hermes_cli.plugins import PluginManager, PluginManifest, PluginContext

adapter_root = Path(sys.argv[1])
manifest = PluginManifest(
    name="memlume",
    source="user",
    path=str(adapter_root),
    key="memlume",
)
manager = PluginManager()
module = manager._load_directory_module(manifest)
assert callable(module.register), "directory plugin must export register(ctx)"
module.register(PluginContext(manifest, manager))
assert "pre_llm_call" in manager._hooks
assert "subagent_start" in manager._hooks
'''
        completed = subprocess.run(
            [str(hermes_python), "-c", script, str(ADAPTER_ROOT)],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode != 0 and "No module named" in completed.stderr and "hermes_cli" in completed.stderr:
            self.skipTest("configured Hermes Python does not contain hermes_cli")
        self.assertEqual(
            completed.returncode,
            0,
            completed.stderr or completed.stdout,
        )


if __name__ == "__main__":
    unittest.main()
