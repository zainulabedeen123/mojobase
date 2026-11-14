#!/usr/bin/env python3
"""Rebrand InsForge prose (README / reference docs) to Mojobase.

Only for documentation text. Source code is edited by hand so wire-protocol
names (cookies, headers, env vars the backend sets) stay compatible.
Usage: rebrand-text.py FILE...
"""
import re
import sys

RULES = [
    (r"@insforge/(sdk|mcp|install)\b", r"@mojobase/\1"),
    (r"https?://docs\.insforge\.dev[^\s)\"'>]*", "https://mojobase.dev/docs"),
    (r"https?://(www\.)?insforge\.dev/dashboard[^\s)\"'>]*", "https://mojobase.dev"),
    (r"https?://github\.com/InsForge/[A-Za-z0-9_.-]+", "https://github.com/zainulabedeen123/mojobase"),
    (r"https?://(www\.)?insforge\.dev[^\s)\"'>]*", "https://mojobase.dev"),
    (r"https?://your-app\.(region\.)?insforge\.app", "https://your-project.mojobase.dev"),
    (r"https?://\{?[A-Za-z_-]+\}?\.\{?[A-Za-z_-]*\}?\.?insforge\.app", "https://your-project.mojobase.dev"),
    (r"\b[a-z0-9-]+\.[a-z0-9-]+\.insforge\.app\b", "your-project.mojobase.dev"),
    (r"\bNEXT_PUBLIC_INSFORGE_", "NEXT_PUBLIC_MOJOBASE_"),
    (r"\bVITE_INSFORGE_", "VITE_MOJOBASE_"),
    (r"\bINSFORGE_(URL|ANON_KEY|API_KEY|BASE_URL)\b", r"MOJOBASE_\1"),
    (r"\bconst insforge\b", "const mojobase"),
    (r"\binsforge\.(auth|database|storage|functions|realtime|ai|emails|payments)\b", r"mojobase.\1"),
    (r"\bInsForge Cloud\b", "Mojobase"),
    (r"\bInsForge\b|\bInsforge\b|\bINSFORGE\b", "Mojobase"),
]


def rebrand(text: str) -> str:
    for pattern, repl in RULES:
        text = re.sub(pattern, repl, text)
    return text


if __name__ == "__main__":
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            src = f.read()
        out = rebrand(src)
        if out != src:
            with open(path, "w", encoding="utf-8") as f:
                f.write(out)
            print("rebranded", path)
