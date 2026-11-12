"""Regression checks for specific contradictory or destructive skill instructions."""
from pathlib import Path
import unittest

BASE = Path(__file__).resolve().parents[4] / 'core/crates/openh3-app/assets/builtin-skills'


def read(name):
    return (BASE / name / 'SKILL.md').read_text(encoding='utf-8')


class SkillRules(unittest.TestCase):
    def test_scenes_allow_required_dependencies(self):
        self.assertNotIn('never stack', read('auto-inject/officecli'))

    def test_repair_can_continue_after_three_cycles(self):
        self.assertNotIn('let the user decide', read('officecli-pptx'))

    def test_learning_does_not_require_new_session(self):
        self.assertNotIn('open a second session', read('officecli-academic-paper'))
        self.assertNotIn('open a pptx v2 session', read('officecli-pitch-deck'))

    def test_docx_does_not_force_short_document_toc_or_padding(self):
        doc = read('officecli-docx')
        self.assertNotIn('TOC present when the document has 3+ headings', doc)
        self.assertNotIn('Pad a thin cover', doc)
        self.assertNotIn('For any document with 3+ headings', doc)
        self.assertNotIn('hit the ≥ 60% filled floor', doc)
        self.assertIn('case "${PAGE_REQUIRED', doc)

    def test_pitch_inherits_current_gates_and_user_structure(self):
        doc = read('officecli-pitch-deck')
        for obsolete in ('L637-679', 'C-P-1', 'C-P-2', 'Gate 1–5a', 'Gates 1–5a', '10 essential slides in a fixed order', 'must be a four-bucket pie'):
            self.assertNotIn(obsolete, doc)

    def test_financial_fallback_preserves_formula(self):
        doc = read('officecli-financial-model')
        for destructive in ('leave `=0`', 'hardcode the computed value', 'OK for delivery', 'cached valuation; refreshes on open'):
            self.assertNotIn(destructive, doc)

    def test_print_does_not_hide_chart_sources(self):
        doc = read('officecli-data-dashboard')
        for contradictory in ('hide non-Dashboard sheets', 'Every non-Dashboard sheet must be hidden', 'for S in Sheet1 Summary', 'non-Dashboard sheets hidden'):
            self.assertNotIn(contradictory, doc)
        self.assertIn('Gate 8 — Formula sanity', doc)
        self.assertIn('cachedValue', doc.split('Gate 8 — Formula sanity')[1])

    def test_form_example_never_deletes_existing_output(self):
        self.assertNotIn('rm -f "$FILE"', read('officecli-word-form'))

    def test_form_validate_checks_command_failure(self):
        self.assertIn('if ! VAL_OUT=$(officecli validate', read('officecli-word-form'))

    def test_citation_gate_is_not_count_comparison(self):
        self.assertNotIn('"$CITATIONS" -le "$ENTRIES"', read('officecli-academic-paper'))


if __name__ == '__main__':
    unittest.main()
