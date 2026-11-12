import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
HELPER = ROOT / 'core/crates/openh3-app/assets/builtin-skills/morph-ppt/reference/morph-helpers.py'
spec = importlib.util.spec_from_file_location('morph_helpers', HELPER)
morph = importlib.util.module_from_spec(spec)
spec.loader.exec_module(morph)


def result(children=None, transition='morph'):
    return json.dumps({'data': {'results': [{'type': 'slide', 'format': {'transition': transition}, 'children': children or []}]}})


class MorphHelpersTest(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stdout(self.output)
        self.redirect.__enter__()

    def tearDown(self):
        self.redirect.__exit__(None, None, None)

    def test_wrapped_old_content_is_rejected(self):
        shape = {'type': 'textbox', 'path': '/slide[2]/shape[1]', 'text': 'Prior slide title',
                 'format': {'name': '!!#s1-title', 'x': '2cm', 'y': '1cm'}}
        with patch.object(morph, '_run', return_value=(0, result([shape]), '')):
            self.assertFalse(morph.morph_verify_slide('unused.pptx', 2))

    def test_command_failure_cannot_pass_using_valid_stdout(self):
        with patch.object(morph, '_run', return_value=(1, result(), 'unavailable')):
            self.assertFalse(morph.morph_verify_slide('unused.pptx', 2))

    def test_unknown_shape_schema_is_not_empty_success(self):
        payload = json.dumps({'data': {'format': {'transition': 'morph'}}})
        with patch.object(morph, '_run', return_value=(0, payload, '')):
            self.assertFalse(morph.morph_verify_slide('unused.pptx', 2))

    def test_compact_json_valid_ghost_passes(self):
        shape = {'type': 'textbox', 'text': 'Prior slide title',
                 'format': {'name': '#s1-title', 'x': '36cm', 'y': '1cm'}}
        compact = result([shape]).replace(': ', ':')
        with patch.object(morph, '_run', return_value=(0, compact, '')):
            self.assertTrue(morph.morph_verify_slide('unused.pptx', 2))

    def test_failed_ghost_does_not_claim_complete(self):
        with patch.object(morph, '_run', return_value=(1, '', 'write failed')):
            with self.assertRaises(RuntimeError):
                morph.morph_ghost_content('unused.pptx', 2, 1)
        self.assertNotIn('Ghosting complete', self.output.getvalue())

    def test_clone_stops_before_next_write_on_failure(self):
        with patch.object(morph, '_run', return_value=(1, '', 'clone failed')) as run:
            with self.assertRaises(RuntimeError):
                morph.morph_clone_slide('unused.pptx', 1, 2)
        self.assertEqual(run.call_count, 1)

    def test_final_check_rejects_failed_inspection(self):
        def run(*args):
            return (0, '1 slides', '') if args[1] == 'view' else (1, '', 'query failed')
        with patch.object(morph, '_run', side_effect=run):
            self.assertFalse(morph.morph_final_check('unused.pptx'))

    def test_cleanup_does_not_delete_by_arbitrary_count(self):
        shapes = [{'path': f'/slide[2]/shape[{i}]', 'format': {'id': i, 'name': f'!!actor-{i}'}} for i in range(1, 61)]
        with patch.object(morph, '_run', return_value=(0, json.dumps({'data': {'results': shapes}}), '')) as run:
            morph.clean_ghost_accumulation('unused.pptx')
        self.assertFalse(any(call.args[1] == 'remove' for call in run.call_args_list))
        self.assertNotIn('Cleaned', self.output.getvalue())

    def test_persistent_heading_is_review_not_failure(self):
        heading = {'type': 'textbox', 'text': 'Company quarterly report',
                   'format': {'name': '!!persistent-heading', 'x': '1cm', 'y': '1cm'}}
        with patch.object(morph, '_run', return_value=(0, result([heading]), '')):
            self.assertTrue(morph.morph_verify_slide('unused.pptx', 2))
        self.assertIn('repetition alone is not an error', self.output.getvalue())

    def test_failed_ghost_readback_is_not_complete(self):
        responses = [(0, '', ''), (0, json.dumps({'data': {'format': {'x': '2cm'}}}), '')]
        with patch.object(morph, '_run', side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, 'readback failed'):
                morph.morph_ghost_content('unused.pptx', 2, 1)
        self.assertNotIn('Ghosting complete', self.output.getvalue())

    def test_transition_inside_unrelated_shape_is_not_slide_transition(self):
        raw = result([{'format': {'transition': 'morph'}}], transition='fade')
        with patch.object(morph, '_run', return_value=(0, raw, '')):
            self.assertFalse(morph.morph_verify_slide('unused.pptx', 2))

    def test_clone_success_reads_back_written_transition(self):
        with patch.object(morph, '_run', side_effect=[(0, 'Copied to /slide[2]', ''), (0, '', ''), (0, result(), '')]) as run:
            morph.morph_clone_slide('unused.pptx', 1, 2)
        self.assertEqual([call.args[1] for call in run.call_args_list], ['add', 'set', 'get'])

    def test_complete_deck_inspects_first_and_last_slide_without_animation_claim(self):
        def run(*args):
            if args[1] == 'view':
                return 0, '7 slides', ''
            if args[1] == 'query':
                return 0, json.dumps({'data': {'results': []}}), ''
            return 0, result(), ''
        with patch.object(morph, '_run', side_effect=run) as calls:
            self.assertTrue(morph.morph_final_check('unused.pptx'))
        paths = [call.args[3] for call in calls.call_args_list if call.args[1] == 'get']
        self.assertIn('/slide[1]', paths)
        self.assertIn('/slide[7]', paths)
        self.assertNotIn('animations should work correctly', self.output.getvalue())

    def test_malformed_results_and_failed_response_are_rejected(self):
        for raw in ('not json', '{"data":{"results":null}}', '{"success":false,"data":{"results":[]}}'):
            with self.subTest(raw=raw), patch.object(morph, '_run', return_value=(0, raw, '')):
                self.assertFalse(morph.morph_verify_slide('unused.pptx', 2))

    def test_truncated_nested_group_is_not_a_complete_shape_inspection(self):
        # Official NodeBuilder builds children only while depth > 0. Its
        # childCount still exposes omitted group content at the depth boundary.
        group = {'path': '/slide[2]/group[1]/group[1]', 'type': 'group',
                 'format': {'name': 'nested-group'}, 'childCount': 1, 'children': []}
        with patch.object(morph, '_run', return_value=(0, result([group]), '')):
            self.assertFalse(morph.morph_verify_slide('unused.pptx', 2))
        self.assertNotIn('structural checks passed', self.output.getvalue())

    def test_slide_count_comes_from_outline_header_count_not_file_name(self):
        # ViewAsOutline emits: File: {basename} | {count} slides.
        def run(*args):
            if args[1] == 'view':
                return 0, 'File: 1 slides.pptx | 7 slides\n', ''
            if args[1] == 'query':
                return 0, json.dumps({'data': {'results': []}}), ''
            return 0, result(), ''
        with patch.object(morph, '_run', side_effect=run) as calls:
            self.assertTrue(morph.morph_final_check('1 slides.pptx'))
        paths = [call.args[3] for call in calls.call_args_list if call.args[1] == 'get']
        self.assertIn('/slide[7]', paths)
        self.assertIn('All 7 slides', self.output.getvalue())

    def test_clone_must_not_mutate_existing_target_after_appending_elsewhere(self):
        # Simulate a deck with 7 existing slides. No insertion flag means the
        # official CopyFrom appends /slide[8], regardless of helper to_slide=2.
        def run(*args):
            if args[1] == 'add':
                if '--index' in args and args[args.index('--index') + 1] == '1':
                    return 0, 'Copied to /slide[2]', ''
                return 0, 'Copied to /slide[8]', ''
            return 0, result(), ''
        with patch.object(morph, '_run', side_effect=run) as calls:
            try:
                morph.morph_clone_slide('seven-slide-deck.pptx', 1, 2)
            except RuntimeError:
                pass  # Refusing the mismatch is also safe.
        adds = [call.args for call in calls.call_args_list if call.args[1] == 'add']
        writes = [call.args for call in calls.call_args_list if call.args[1] == 'set']
        if writes:
            self.assertTrue(adds)
            self.assertIn('--index', adds[0], 'An append cannot establish that /slide[2] is the clone')
            self.assertEqual(adds[0][adds[0].index('--index') + 1], '1')
            self.assertTrue(all(args[3] == '/slide[2]' for args in writes))

    def test_unknown_node_with_empty_tree_does_not_validate_as_slide(self):
        # Merely having format={} and children=[] does not identify a slide.
        raw = json.dumps({'success': True, 'data': {'format': {}, 'children': []}})
        with patch.object(morph, '_run', return_value=(0, raw, '')):
            self.assertFalse(morph.morph_verify_slide('unused.pptx', 1))

    def test_inspect_ghosts_rejects_invalid_format_without_printing_a_count(self):
        raw = json.dumps({'success': True, 'data': {'results': [{'format': None}]}})
        with patch.object(morph, '_run', return_value=(0, raw, '')):
            with self.assertRaises(RuntimeError):
                morph.inspect_ghosts('unused.pptx')
        self.assertNotIn('Found 1 off-slide shapes', self.output.getvalue())

    def test_ghosted_parent_group_does_not_reject_relative_child_position(self):
        child = {'type': 'textbox', 'format': {'name': '!!#s1-title', 'x': '1cm'}}
        group = {'type': 'group', 'format': {'name': '!!#s1-content', 'x': '36cm'}, 'childCount': 1, 'children': [child]}
        with patch.object(morph, '_run', return_value=(0, result([group]), '')):
            self.assertTrue(morph.morph_verify_slide('unused.pptx', 2))

    def test_mixed_deck_checks_every_slide_but_only_requires_planned_morph(self):
        def run(*args):
            if args[1] == 'view':
                return 0, 'File: mixed.pptx | 3 slides', ''
            if args[1] == 'query':
                return 0, json.dumps({'data': {'results': []}}), ''
            return 0, result(transition='morph' if args[3] == '/slide[2]' else 'fade'), ''
        with patch.object(morph, '_run', side_effect=run) as calls:
            self.assertTrue(morph.morph_final_check('unused.pptx', [2]))
        self.assertIn('/slide[3]', [call.args[3] for call in calls.call_args_list if call.args[1] == 'get'])


if __name__ == '__main__':
    unittest.main()
