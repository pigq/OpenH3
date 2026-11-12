"""Executable regression tests for the bundled creator (requires PyYAML)."""

import contextlib
import io
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = APP_ROOT / 'assets/builtin-skills/auto-inject/skill-creator/scripts'
sys.path.insert(0, str(SCRIPTS))
from package_skill import package_skill
from quick_validate import validate_skill


class SkillCreatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skill = self.root / 'test-skill'
        self.skill.mkdir()

    def manifest(self, name='test-skill', description='Use for a test task.'):
        import json
        text = f'---\nname: {json.dumps(name)}\ndescription: {json.dumps(description, ensure_ascii=False)}\n---\n# Test\n'
        (self.skill / 'SKILL.md').write_text(text, encoding='utf-8')

    def test_rejects_empty_and_whitespace_metadata(self):
        for field in ('name', 'description'):
            for value in ('', ' \t '):
                with self.subTest(field=field, value=repr(value)):
                    self.manifest(**{field: value})
                    valid, message = validate_skill(self.skill)
                    self.assertFalse(valid)
                    self.assertIn(f'{field.capitalize()} must not be empty', message)

    def test_reads_utf8_under_a_non_utf8_default(self):
        self.manifest(description='处理中文任务 🚀”')
        # Force the Windows locale encoding through Path.read_text's default.
        from unittest.mock import patch
        original = Path.read_text

        def locale_read(path, encoding=None, errors=None):
            return original(path, encoding=encoding or 'cp1252', errors=errors)

        with patch.object(Path, 'read_text', locale_read):
            valid, message = validate_skill(self.skill)
        self.assertTrue(valid, message)

    def test_packages_importable_zip_with_utf8_resources(self):
        self.manifest(description='处理中文任务')
        resource = self.skill / 'references' / '说明.md'
        resource.parent.mkdir()
        resource.write_bytes('中文内容\n'.encode('utf-8'))
        with contextlib.redirect_stdout(io.StringIO()):
            archive = package_skill(self.skill, self.root / 'dist')
        self.assertIsNotNone(archive)
        self.assertEqual(archive.suffix, '.zip')
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(set(zipped.namelist()), {'test-skill/SKILL.md', 'test-skill/references/说明.md'})
            self.assertEqual(zipped.read('test-skill/references/说明.md').decode('utf-8'), '中文内容\n')

    def test_invalid_metadata_does_not_create_an_archive(self):
        self.manifest(description=' ')
        with contextlib.redirect_stdout(io.StringIO()):
            result = package_skill(self.skill, self.root / 'dist')
        self.assertIsNone(result)
        self.assertFalse((self.root / 'dist').exists())

    def test_invalid_utf8_returns_a_validation_failure(self):
        (self.skill / 'SKILL.md').write_bytes(b'---\nname: test-skill\ndescription: \xff\n---\n')
        valid, message = validate_skill(self.skill)
        self.assertFalse(valid)
        self.assertIn('Cannot read UTF-8 SKILL.md', message)

    def test_basic_validation_does_not_claim_resource_checks(self):
        self.manifest()
        with (self.skill / 'SKILL.md').open('a', encoding='utf-8') as manifest:
            manifest.write('[Missing reference](references/missing.md)\n')
        valid, message = validate_skill(self.skill)
        self.assertTrue(valid, message)
        self.assertIn('resources and instruction quality not checked', message)

    def test_init_and_package_support_legacy_console_encoding(self):
        # The API is called with an ASCII console to reproduce Windows consoles
        # that cannot print emoji. File content must still use UTF-8 explicitly.
        script = '''
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
sys.stdout.reconfigure(encoding='ascii')
from init_skill import init_skill
from package_skill import package_skill
skill = init_skill('generated-skill', sys.argv[2])
assert skill is not None
text = (skill / 'SKILL.md').read_text(encoding='utf-8')
assert '→' in text
(skill / 'SKILL.md').write_text('---\\nname: generated-skill\\ndescription: Test\\n---\\n', encoding='utf-8')
assert package_skill(skill, Path(sys.argv[2]) / 'dist') is not None
'''
        result = subprocess.run([sys.executable, '-c', script, str(SCRIPTS), str(self.root)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))


if __name__ == '__main__':
    unittest.main()
