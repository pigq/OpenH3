"""Exercise the Bash compatibility wrapper with real subprocesses.

Windows uses Git Bash beside the installed Git executable, never a WSL shim.
Set MORPH_TEST_BASH to a compatible Bash executable to override discovery.
The isolated Python probe records arguments; no OfficeCLI or PPTX is touched.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[4]
REFERENCE = ROOT / 'core/crates/openh3-app/assets/builtin-skills/morph-ppt/reference'
git = shutil.which('git')
git_bash = Path(git).resolve().parents[1] / 'bin/bash.exe' if git else None
BASH = os.environ.get('MORPH_TEST_BASH')
if not BASH:
    BASH = str(git_bash) if git_bash and git_bash.is_file() else (shutil.which('bash') if os.name != 'nt' else None)


@unittest.skipUnless(BASH, 'A native Bash runtime (Git Bash on Windows) is required')
class MorphShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='morph shell 中文 ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skill = self.root / 'installed helper 中文 with spaces'
        self.cwd = self.root / 'different user 工作目录'
        self.skill.mkdir()
        self.cwd.mkdir()
        self.shell = self.skill / 'morph-helpers.sh'
        shutil.copyfile(REFERENCE / 'morph-helpers.sh', self.shell)
        (self.skill / 'morph-helpers.py').write_text(
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "print(json.dumps({'args':sys.argv[1:],'script':str(Path(__file__).resolve()),'cwd':os.getcwd()}))\n"
            "print('probe-stderr', file=sys.stderr)\n"
            "sys.exit(int(os.environ['MORPH_TEST_EXIT']))\n",
            encoding='utf-8',
        )
        self.env = dict(os.environ, MORPH_PYTHON=Path(sys.executable).as_posix(),
                        PYTHONDONTWRITEBYTECODE='1', PYTHONUTF8='1')

    def run_wrapper(self, args, code=0, function=None):
        env = dict(self.env, MORPH_TEST_EXIT=str(code))
        if function:
            script = 'source "$1"; cd -- "$2"; shift 2; "$@"'
            command = [BASH, '-c', script, 'morph-test', self.shell.as_posix(),
                       self.cwd.as_posix(), function, *args]
        else:
            command = [BASH, self.shell.as_posix(), *args]
        return subprocess.run(command, cwd=self.root if function else self.cwd, env=env, capture_output=True,
                              text=True, encoding='utf-8', errors='replace', timeout=30)

    def assert_probe(self, result, expected_args, code):
        self.assertEqual(result.returncode, code, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload['args'], expected_args)
        self.assertEqual(Path(payload['script']), self.skill / 'morph-helpers.py')
        self.assertEqual(Path(payload['cwd']), self.cwd)
        self.assertIn('probe-stderr', result.stderr)

    def test_direct_invocation_preserves_unicode_spaces_arguments_and_status(self):
        for code in (0, 23):
            with self.subTest(code=code):
                args = ['final-check', 'deck 中文 with spaces.pptx', '--morph-slides', '2,4']
                self.assert_probe(self.run_wrapper(args, code), args, code)

    def test_all_sourced_functions_delegate_and_preserve_failure_status(self):
        cases = [
            ('morph_clone_slide', 'clone', ['1', '2']),
            ('morph_ghost_content', 'ghost', ['2', '1', '3']),
            ('morph_verify_slide', 'verify', ['2']),
            ('morph_final_check', 'final-check', ['--morph-slides', '2,4']),
        ]
        for function, subcommand, options in cases:
            for code in (0, 23):
                with self.subTest(function=function, code=code):
                    args = ['deck 中文 with spaces.pptx', *options]
                    result = self.run_wrapper(args, code, function)
                    self.assert_probe(result, [subcommand, *args], code)

    def test_missing_explicit_interpreter_exits_nonzero_without_probe_success(self):
        self.env['MORPH_PYTHON'] = (self.root / 'missing python executable').as_posix()
        result = self.run_wrapper(['verify', 'deck.pptx', '2'])
        self.assertEqual(result.returncode, 127)
        self.assertEqual(result.stdout, '')

    def test_interpreter_path_with_unicode_and_spaces_is_one_argument(self):
        interpreter = self.root / 'python runner 中文 with spaces'
        executable = Path(sys.executable).as_posix().replace("'", "'\"'\"'")
        interpreter.write_text(f"#!/usr/bin/env bash\nexec '{executable}' \"$@\"\n", encoding='utf-8')
        interpreter.chmod(0o755)
        self.env['MORPH_PYTHON'] = interpreter.as_posix()
        args = ['verify', 'deck 中文 with spaces.pptx', '2']
        self.assert_probe(self.run_wrapper(args, 23), args, 23)

    def test_real_python_helper_help_and_invalid_input_status(self):
        shutil.copyfile(REFERENCE / 'morph-helpers.py', self.skill / 'morph-helpers.py')
        help_result = self.run_wrapper(['--help'])
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn('final-check', help_result.stdout)
        invalid = self.run_wrapper(['verify', 'deck.pptx', '0'])
        self.assertEqual(invalid.returncode, 1, invalid.stderr)
        self.assertIn('Slide index must be positive', invalid.stdout)
        self.assertNotIn('structural checks passed', invalid.stdout)


if __name__ == '__main__':
    unittest.main()
