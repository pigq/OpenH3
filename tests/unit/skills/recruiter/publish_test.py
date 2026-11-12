"""Offline publisher contracts. No real Playwright, network, or browser is used."""
import importlib.util
import contextlib
import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
SKILLS = ROOT / 'core/crates/openh3-app/assets/builtin-skills'
sys.dont_write_bytecode = True
stub = types.ModuleType('playwright.sync_api')
stub.sync_playwright = lambda: None
sys.modules['playwright.sync_api'] = stub


def load(name):
    script = SKILLS / name / 'scripts' / ('publish_x.py' if name == 'x-recruiter' else 'publish_xiaohongshu.py')
    spec = importlib.util.spec_from_file_location(name, script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Locator:
    def __init__(self, page, key):
        self.page, self.key = page, key

    @property
    def first(self):
        return self

    @property
    def last(self):
        return self

    def nth(self, _index):
        return self

    def count(self):
        if '扫码登录' in self.key or '上传图文' in self.key:
            return 0
        if self.page.failure == 'missing_body' and ('contenteditable' in self.key or 'ql-editor' in self.key):
            return 0
        if self.page.failure == 'upload_pending' and 'removeMedia' in self.key:
            return 0
        return 1

    def is_visible(self):
        if self.key == '发布成功':
            return self.page.submissions > 0 and self.page.failure != 'unconfirmed'
        return self.count() > 0

    def is_enabled(self):
        return self.page.failure != 'disabled'

    def wait_for(self, **_kwargs):
        if (self.page.failure == 'upload_pending' and '18' in self.key) or (
            self.page.failure == 'unconfirmed' and self.key == '发布成功'
        ):
            raise TimeoutError('not observed')

    def set_input_files(self, _files):
        if self.page.failure == 'upload':
            raise RuntimeError('upload rejected')

    def fill(self, text):
        if self.page.failure == 'fill':
            raise RuntimeError('editor rejected fill')
        self.page.values[self.key] = text

    def input_value(self):
        return self.page.values.get(self.key, '')

    def inner_text(self):
        return 'changed' if self.page.failure == 'mismatch' else self.page.values.get(self.key, '')

    def text_content(self):
        return self.inner_text()

    def click(self):
        if self.key == '发布' or 'tweetButton' in self.key:
            self.page.submissions += 1


class Page:
    def __init__(self, failure=None):
        self.failure, self.values, self.submissions = failure, {}, 0
        self.url = 'https://creator.xiaohongshu.com/publish/publish'

    def locator(self, key):
        return Locator(self, key)

    def get_by_role(self, _role, name):
        return Locator(self, name)

    def get_by_text(self, text, **_kwargs):
        return Locator(self, text)

    def goto(self, *_args, **_kwargs):
        pass

    def wait_for_selector(self, *_args, **_kwargs):
        pass

    def wait_for_load_state(self, *_args, **_kwargs):
        pass

    def wait_for_timeout(self, *_args):
        pass

    def title(self):
        return 'Creator'

    def content(self):
        return ''

    def expect_response(self, _predicate, **_kwargs):
        page = self
        class Response:
            def __enter__(self):
                content = next(iter(page.values.values()))
                payload = {} if page.failure == 'unconfirmed' else {
                    'data': {'create_tweet': {'tweet_results': {'result': {
                        'rest_id': '123', 'legacy': {'full_text': content}
                    }}}}
                }
                self.value = types.SimpleNamespace(ok=True, json=lambda: payload)
                return self
            def __exit__(self, *_args):
                pass
        return Response()


class Publishers(unittest.TestCase):
    def test_x_source_parses(self):
        load('x-recruiter')

    def test_xhs_upload_failure_never_publishes(self):
        module = load('xiaohongshu-recruiter')
        page = Page('upload')
        with self.assertRaises(RuntimeError):
            module.prepare_and_publish(page, 'Role', 'Known responsibilities', ['image.png'])
        self.assertEqual(page.submissions, 0, 'upload failure must not reach Publish')

    def test_xhs_all_preparation_failures_prevent_submission(self):
        module = load('xiaohongshu-recruiter')
        for failure in ('missing_body', 'fill', 'mismatch', 'upload_pending'):
            with self.subTest(failure=failure):
                page = Page(failure)
                with self.assertRaises((RuntimeError, TimeoutError)):
                    module.prepare_and_publish(page, 'Role', 'Known responsibilities', ['image.png'])
                self.assertEqual(page.submissions, 0)

    def test_xhs_click_without_success_is_unknown_and_never_retried(self):
        module = load('xiaohongshu-recruiter')
        page = Page('unconfirmed')
        with self.assertRaisesRegex(RuntimeError, 'unknown'):
            module.prepare_and_publish(page, 'Role', 'Known responsibilities', ['image.png'])
        self.assertEqual(page.submissions, 1)

    def test_xhs_success_requires_success_observation(self):
        page = Page()
        result = load('xiaohongshu-recruiter').prepare_and_publish(page, 'Role', 'Known responsibilities', ['image.png'])
        self.assertEqual(result['status'], 'published')
        self.assertEqual(page.submissions, 1)

    def test_x_verification_requires_matching_returned_post(self):
        module = load('x-recruiter')
        valid = {'data': {'create_tweet': {'tweet_results': {'result': {
            'rest_id': '123', 'legacy': {'full_text': 'Role details'}
        }}}}}
        self.assertEqual(module.verify_post_response(valid, 'Role details'), 'https://x.com/i/status/123')
        for invalid in ({}, {'errors': [{'message': 'denied'}]}, {'data': valid['data'], 'errors': ['denied']}):
            with self.assertRaises(RuntimeError):
                module.verify_post_response(invalid, 'Role details')
        with self.assertRaises(RuntimeError):
            module.verify_post_response(valid, 'different text')
        with self.assertRaises(RuntimeError):
            module.verify_post_response(valid, 'Role details', 1)
        legacy = valid['data']['create_tweet']['tweet_results']['result']['legacy']
        legacy['entities'] = {'media': [{'url': 'https://t.co/image'}]}
        legacy['full_text'] += ' https://t.co/image'
        self.assertEqual(module.verify_post_response(valid, 'Role details', 1), 'https://x.com/i/status/123')

    def test_x_preparation_failure_never_publishes(self):
        module = load('x-recruiter')
        for failure in ('fill', 'mismatch', 'upload', 'upload_pending', 'disabled'):
            with self.subTest(failure=failure):
                page = Page(failure)
                with self.assertRaises(RuntimeError):
                    module.prepare_and_publish(page, 'Role details', ['image.png'])
                self.assertEqual(page.submissions, 0)

    def test_x_result_uncertainty_is_not_retried(self):
        page = Page('unconfirmed')
        with self.assertRaisesRegex(RuntimeError, 'unknown'):
            load('x-recruiter').prepare_and_publish(page, 'Role details', [])
        self.assertEqual(page.submissions, 1)

    def test_x_success_returns_matching_post_link(self):
        page = Page()
        result = load('x-recruiter').prepare_and_publish(page, 'Role details', [])
        self.assertEqual(result, {'status': 'published', 'url': 'https://x.com/i/status/123'})
        self.assertEqual(page.submissions, 1)

    def test_x_main_accepts_absolute_input_from_unrelated_cwd(self):
        module = load('x-recruiter')
        page = Page()
        browser = types.SimpleNamespace(new_page=lambda: page, close=lambda: None)
        runtime = types.SimpleNamespace(chromium=types.SimpleNamespace(launch=lambda **_args: browser))
        with tempfile.TemporaryDirectory() as folder:
            content = Path(folder) / 'post.txt'
            content.write_text('Role details', encoding='utf-8')
            previous = os.getcwd()
            try:
                os.chdir(folder)
                with patch.object(module, 'sync_playwright', return_value=contextlib.nullcontext(runtime)), patch.object(
                    sys, 'argv', ['publish_x.py', str(content)]
                ), contextlib.redirect_stdout(io.StringIO()) as output:
                    module.main()
                self.assertIn('https://x.com/i/status/123', output.getvalue())
                self.assertEqual(page.submissions, 1)
            finally:
                os.chdir(previous)

    def test_xhs_local_validation_never_starts_browser(self):
        module = load('xiaohongshu-recruiter')
        with patch.object(module, 'sync_playwright') as runtime:
            for title, content, images in [('', 'body', ['x.png']), ('a' * 21, 'body', ['x.png']),
                                          ('Role', '', ['x.png']), ('Role', 'body', []),
                                          ('Role', 'body', ['does-not-exist.png'])]:
                with self.assertRaises(ValueError):
                    module.publish(title, content, images)
            runtime.assert_not_called()


if __name__ == '__main__':
    unittest.main()
