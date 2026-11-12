#!/usr/bin/env bash
# Compatibility functions delegate to the checked Python implementation.
# MORPH_PYTHON may point to an available Python executable (without extra args).
_morph_helper_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/morph-helpers.py"
_morph_run() {
    local interpreter="${MORPH_PYTHON:-}"
    if [[ -z "$interpreter" ]]; then
        if command -v python3 >/dev/null 2>&1; then interpreter=python3
        elif command -v python >/dev/null 2>&1; then interpreter=python
        else printf '%s\n' 'Python is required for Morph verification.' >&2; return 127
        fi
    fi
    "$interpreter" "$_morph_helper_path" "$@"
}
morph_clone_slide() { _morph_run clone "$@"; }
morph_ghost_content() { _morph_run ghost "$@"; }
morph_verify_slide() { _morph_run verify "$@"; }
morph_final_check() { _morph_run final-check "$@"; }
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    _morph_run "$@"
    exit $?
fi
