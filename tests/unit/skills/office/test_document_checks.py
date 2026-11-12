"""Exercise bundled DOCX checks against ZIP/XML fixtures, without OfficeCLI."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / 'core/crates/openh3-app/assets/builtin-skills/officecli-docx/scripts/document_checks.py'
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


class DocumentChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'sample.docx'

    def document(self, body='', protection='', footer=None):
        with zipfile.ZipFile(self.path, 'w') as doc:
            section = '<w:sectPr><w:footerReference w:type="default" r:id="footer1"/></w:sectPr>' if footer is not None else ''
            doc.writestr('word/document.xml', f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}{section}</w:body></w:document>')
            doc.writestr('word/settings.xml', f'<w:settings xmlns:w="{W}">{protection}</w:settings>')
            if footer is not None:
                doc.writestr('word/footer1.xml', f'<w:ftr xmlns:w="{W}">{footer}</w:ftr>')
                doc.writestr('word/_rels/document.xml.rels', f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="footer1" Type="{R}/footer" Target="footer1.xml"/></Relationships>')

    def run_check(self, command, *args):
        self.assertTrue(SCRIPT.is_file(), 'DOCX structural checker is not bundled')
        return subprocess.run([sys.executable, str(SCRIPT), command, str(self.path), *args], capture_output=True, text=True)

    def test_single_page_without_numbers_is_explicitly_not_required(self):
        self.document()
        result = self.run_check('page', '--not-required-reason', 'Verified one-page letter')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('NOT REQUIRED', result.stdout)

    def test_required_page_rejects_literal_page_number(self):
        self.document(footer='<w:p><w:r><w:t>Page 1</w:t></w:r></w:p>')
        result = self.run_check('page', '--required')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('live PAGE field', result.stderr)

    def test_required_page_accepts_split_instruction(self):
        self.document(footer='<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PA</w:instrText></w:r><w:r><w:instrText>GE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')
        self.assertEqual(self.run_check('page', '--required').returncode, 0)

    def test_page_instruction_without_field_structure_is_rejected(self):
        self.document(footer='<w:p><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>')
        self.assertNotEqual(self.run_check('page', '--required').returncode, 0)

    def test_simple_page_field_is_accepted(self):
        self.document(footer='<w:p><w:fldSimple w:instr=" PAGE "/></w:p>')
        self.assertEqual(self.run_check('page', '--required').returncode, 0)

    def test_orphan_footer_field_cannot_satisfy_page_requirement(self):
        self.document()
        with zipfile.ZipFile(self.path, 'a') as doc:
            doc.writestr('word/footer1.xml', f'<w:ftr xmlns:w="{W}"><w:p><w:fldSimple w:instr="PAGE"/></w:p></w:ftr>')
        self.assertNotEqual(self.run_check('page', '--required').returncode, 0)

    def test_forms_mode_without_enforcement_is_rejected(self):
        for value in ('', ' w:enforcement="0"', ' w:enforcement="false"'):
            with self.subTest(value=value):
                self.document(protection=f'<w:documentProtection w:edit="forms"{value}/>')
                result = self.run_check('protection')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('enforced', result.stderr)

    def test_enforced_forms_is_accepted(self):
        for value in ('1', 'true', 'on'):
            with self.subTest(value=value):
                self.document(protection=f'<w:documentProtection w:edit="forms" w:enforcement="{value}"/>')
                self.assertEqual(self.run_check('protection').returncode, 0)

    def test_readonly_mode_is_not_forms(self):
        self.document(protection='<w:documentProtection w:edit="readOnly" w:enforcement="1"/>')
        self.assertNotEqual(self.run_check('protection').returncode, 0)

    def test_missing_citation_key_is_not_hidden_by_paragraph_count(self):
        self.document(''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in ('Body cites [9].', 'Hanging-indent body example.', 'References', '[1] Actual reference.')))
        result = self.run_check('citations', '--bibliography-heading', 'References')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('[9]', result.stderr)

    def test_ieee_groups_ranges_and_split_runs_resolve(self):
        self.document('<w:p><w:r><w:t>Cites [1, 2</w:t></w:r><w:r><w:t>-3].</w:t></w:r></w:p>' + ''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in ('References', '[1] First.', '[2] Second.', '[3] Third.')))
        self.assertEqual(self.run_check('citations', '--bibliography-heading', 'References').returncode, 0)

    def test_missing_or_ambiguous_bibliography_heading_rejected(self):
        for texts in (('Body [1].', '[1] Ref.'), ('References', 'References', '[1] Ref.')):
            self.document(''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in texts))
            self.assertNotEqual(self.run_check('citations', '--bibliography-heading', 'References').returncode, 0)

    def test_duplicate_reference_keys_rejected(self):
        self.document(''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in ('Body [1].', 'References', '[1] First.', '[1] Duplicate.')))
        self.assertNotEqual(self.run_check('citations', '--bibliography-heading', 'References').returncode, 0)

    def test_empty_numeric_scan_is_not_citation_validation(self):
        self.document('<w:p><w:r><w:t>Smith (2024)</w:t></w:r></w:p><w:p><w:r><w:t>References</w:t></w:r></w:p>')
        result = self.run_check('citations', '--bibliography-heading', 'References')
        self.assertNotEqual(result.returncode, 0)

    def test_missing_and_invalid_document_cannot_pass(self):
        self.assertNotEqual(self.run_check('page', '--not-required-reason', 'Single page').returncode, 0)
        self.path.write_text('not a docx', encoding='utf-8')
        self.assertNotEqual(self.run_check('protection').returncode, 0)


if __name__ == '__main__':
    unittest.main()
