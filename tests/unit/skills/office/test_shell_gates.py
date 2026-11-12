"""Execute documented shell gates against controlled command failures, not OfficeCLI."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[4]
BASE = 'core/crates/openh3-app/assets/builtin-skills'
git = shutil.which('git')
git_bash = Path(git).resolve().parents[1] / 'bin/bash.exe' if git else Path('missing')
BASH = str(git_bash) if git_bash.is_file() else (shutil.which('bash') if os.name != 'nt' else None)


def skill(name):
    relative = f'{BASE}/{name}/SKILL.md'
    if os.environ.get('OFFICE_SKILL_TEST_REF'):
        return subprocess.check_output(['git', 'show', f'{os.environ["OFFICE_SKILL_TEST_REF"]}:{relative}'], cwd=ROOT).decode('utf-8')
    return (ROOT / relative).read_text(encoding='utf-8')


@unittest.skipUnless(BASH, 'A real bash runtime is required for shell-snippet tests')
class ShellGates(unittest.TestCase):
    def gate(self, response, exit_code):
        text = skill('officecli-word-form')
        block = text[text.index('# Gate 1 — Validate'):text.index('# Gate 2 — Token')]
        prelude = 'officecli() { printf "%s\\n" "$STUB_OUTPUT"; return "$STUB_EXIT"; }; FILE=unused.docx\n'
        env = dict(os.environ, STUB_OUTPUT=response, STUB_EXIT=str(exit_code))
        return subprocess.run([BASH, '--noprofile', '--norc', '-c', prelude + block], env=env, capture_output=True, text=True)

    def test_validate_failure_without_schema_tag_cannot_pass(self):
        result = self.gate('file not found', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Gate 1 OK', result.stdout)

    def test_failure_code_overrides_success_text(self):
        result = self.gate('no errors found', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Gate 1 OK', result.stdout)

    def test_empty_or_unknown_output_cannot_pass(self):
        for text in ('', 'Internal error'):
            with self.subTest(text=text):
                result = self.gate(text, 0)
                self.assertNotEqual(result.returncode, 0)

    def test_schema_error_cannot_pass(self):
        self.assertNotEqual(self.gate('[Schema] invalid element', 0).returncode, 0)

    def test_clean_validation_passes(self):
        result = self.gate('no errors found', 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Gate 1 OK', result.stdout)


if __name__ == '__main__':
    unittest.main()
