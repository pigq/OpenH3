"""Run the documented PowerShell JSON examples against a native stdin probe.

Windows only; no OpenH3 service is contacted and all runtime values are synthetic.
"""

import base64
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[2] / 'assets/builtin-skills'
CASES = {
    'auto-inject/cron': ['config', 'cron', 'current', 'create'],
    'auto-inject/session-message': ['session', 'send-message'],
    'auto-inject/conversation-create': ['conversation', 'create'],
    'auto-inject/openh3-config': ['config', 'assistants', 'get'],
    'openh3-troubleshooting': ['diagnose', 'conversations', 'get'],
}


def ps_quote(text):
    return "'" + str(text).replace("'", "''") + "'"


def run_ps(shell, text, env):
    encoded = base64.b64encode(text.encode('utf-16-le')).decode('ascii')
    return subprocess.run([shell, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                          input=b'', capture_output=True, env=env, timeout=30)


@unittest.skipUnless(os.name == 'nt', 'PowerShell Windows process/encoding contract')
class HelperSkillPowerShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='helper skill 中文 ')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.helper = Path(cls.temp.name) / 'stdin probe.exe'
        cls.shells = [shutil.which(name) for name in ('powershell.exe', 'pwsh.exe')]
        cls.shells = [shell for shell in cls.shells if shell]
        if not cls.shells:
            raise unittest.SkipTest('No PowerShell executable available')
        cls.env = {key: value for key, value in os.environ.items() if not key.startswith('OPENH3_')}
        cls.env.update(OPENH3_HELPER_BIN=str(cls.helper), OPENH3_USER_ID='test-user',
                       OPENH3_CONVERSATION_ID='test-conversation', OPENH3_BASE_URL='http://invalid.local')
        source = '''
using System;
using System.IO;
using System.Text;
public class Probe {
    public static int Main(string[] args) {
        Console.WriteLine("ARGS:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("\\n", args))));
        using (var input = Console.OpenStandardInput())
        using (var bytes = new MemoryStream()) {
            input.CopyTo(bytes);
            Console.WriteLine("STDIN:" + Convert.ToBase64String(bytes.ToArray()));
        }
        return Environment.GetEnvironmentVariable("HELPER_TEST_FAIL") == "1" ? 23 : 0;
    }
}
'''
        compile_script = f"Add-Type -TypeDefinition @'\n{source}\n'@ -OutputAssembly {ps_quote(cls.helper)} -OutputType ConsoleApplication"
        result = run_ps(cls.shells[0], compile_script, cls.env)
        if result.returncode or not cls.helper.exists():
            raise RuntimeError(result.stderr.decode('utf-8', errors='replace'))

    def test_documented_json_commands_preserve_utf8_context_and_exit_failure(self):
        for skill, expected_args in CASES.items():
            body = (SKILLS / skill / 'SKILL.md').read_text(encoding='utf-8')
            examples = re.findall(r'```powershell\n(.*?)\n```', body, re.DOTALL)
            payloads = [example for example in examples if '$OutputEncoding' in example]
            with self.subTest(skill=skill):
                self.assertEqual(len(payloads), 1, 'Need one executable UTF-8 stdin example')
            if len(payloads) != 1:
                continue
            example = payloads[0]
            for shell in self.shells:
                for fail in (False, True):
                    with self.subTest(skill=skill, shell=Path(shell).name, fail=fail):
                        env = dict(self.env, HELPER_TEST_FAIL='1' if fail else '0')
                        # Capture the failure without hiding it; assert finally
                        # restores the original encoding on both code paths.
                        script = '''
$ErrorActionPreference = 'Stop'
$beforeEncoding = $OutputEncoding
$beforeContext = @(Get-ChildItem Env:OPENH3_* | Sort-Object Name | ForEach-Object { $_.Name + '=' + $_.Value }) -join "`n"
$caught = $false
try {
''' + example + '''
} catch { $caught = $true }
if (-not [object]::ReferenceEquals($beforeEncoding, $OutputEncoding)) { throw 'Encoding leaked' }
$afterContext = @(Get-ChildItem Env:OPENH3_* | Sort-Object Name | ForEach-Object { $_.Name + '=' + $_.Value }) -join "`n"
if ($beforeContext -cne $afterContext) { throw 'Runtime context changed' }
if ($caught -ne ($env:HELPER_TEST_FAIL -eq '1')) { throw 'Failure was not propagated' }
'''
                        result = run_ps(shell, script, env)
                        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
                        output = result.stdout.decode('ascii')
                        args = re.search(r'ARGS:([^\r\n]+)', output)
                        stdin = re.search(r'STDIN:([^\r\n]+)', output)
                        self.assertIsNotNone(args, output)
                        self.assertIsNotNone(stdin, output)
                        self.assertEqual(base64.b64decode(args[1]).decode('utf-8').split('\n'), expected_args)
                        raw = base64.b64decode(stdin[1])
                        self.assertFalse(raw.startswith(b'\xef\xbb\xbf'), 'stdin must not have a BOM')
                        import json
                        payload = json.loads(raw.decode('utf-8'))
                        expected = re.search(r"@'\n(.*?)\n'@", example, re.DOTALL)[1]
                        self.assertEqual(payload, json.loads(expected))
                        self.assertNotIn('test-user', output)


if __name__ == '__main__':
    unittest.main()
