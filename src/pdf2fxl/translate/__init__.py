"""Embedded translation engine.

The full translation corpus (stances, content-type taxonomy, per-language
grammar, register maps, script guards) is vendored under corpus/ so the app is
self-contained: nothing here reaches outside the package at runtime except the
one injected model call.
"""
