"""Hermes directory-plugin entrypoint for Memlume."""

from .memlume_plugin.plugin import register

__all__ = ["register"]
