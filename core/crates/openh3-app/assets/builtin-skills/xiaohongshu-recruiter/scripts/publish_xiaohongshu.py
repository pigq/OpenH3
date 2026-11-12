"""Submit authorized content only after required uploads and fields are checked."""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright


def prepare_and_publish(page, title, content, images):
    upload = page.locator("input[type='file']").first
    upload.wait_for(state='attached', timeout=120000)
    upload.set_input_files(images)
    # A changed layout is an unsupported state, never permission to publish partially.
    page.locator(rf'text=/\({len(images)}\/18\)/').wait_for(state='visible', timeout=30000)
    title_input = page.locator("input[placeholder*='标题']").first
    title_input.wait_for(state='visible', timeout=30000)
    title_input.fill(title)
    if title_input.input_value() != title:
        raise RuntimeError('Title mismatch; nothing submitted.')
    body = None
    for selector in ('.ql-editor', "div[contenteditable='true']"):
        candidate = page.locator(selector)
        if candidate.count() == 1 and candidate.is_visible():
            body = candidate
            break
    if body is None:
        raise RuntimeError('Cannot identify a unique body editor; nothing submitted.')
    body.fill(content)
    if body.inner_text().replace('\r\n', '\n').strip() != content.replace('\r\n', '\n').strip():
        raise RuntimeError('Body mismatch; nothing submitted.')
    publish_button = page.get_by_role('button', name='发布')
    publish_button.wait_for(state='visible', timeout=10000)
    if not publish_button.is_enabled():
        raise RuntimeError('Publish is disabled or uploads are incomplete; nothing submitted.')
    success = page.get_by_text('发布成功', exact=True)
    if success.is_visible():
        raise RuntimeError('A previous success message is visible; inspect existing posts first.')
    try:
        publish_button.click()
        success.wait_for(state='visible', timeout=30000)
    except Exception as error:
        raise RuntimeError('Publication outcome unknown: inspect existing posts before any retry.') from error
    return {'status': 'published', 'evidence': '发布成功', 'pageUrl': page.url}


def publish(title, content, images):
    if not title.strip() or len(title) > 20:
        raise ValueError('Provide a nonempty title of at most 20 characters; it will not be silently truncated.')
    if not content.strip() or len(content) > 1000:
        raise ValueError('Provide nonempty content of at most 1000 characters.')
    if not 1 <= len(images) <= 18:
        raise ValueError('Provide between 1 and 18 images.')
    images = [str(Path(image).resolve()) for image in images]
    for image in images:
        if not Path(image).is_file() or Path(image).stat().st_size == 0:
            raise ValueError(f'Missing or empty image: {image}')
    profile = os.environ.get('XHS_PROFILE_DIR') or str(Path.home() / '.openh3/xiaohongshu-chrome-profile')
    print('Complete login in the dedicated browser. The authorized post will be submitted automatically.', flush=True)
    with sync_playwright() as runtime:
        # Never attach to an unrelated browser/account on a common CDP port.
        context = runtime.chromium.launch_persistent_context(profile, headless=False)
        try:
            page = context.new_page()
            page.goto('https://creator.xiaohongshu.com/publish/publish', wait_until='domcontentloaded')
            page.locator('text=上传图文').last.wait_for(state='visible', timeout=120000)
            page.locator('text=上传图文').last.click()
            return prepare_and_publish(page, title, content, images)
        finally:
            context.close()


if __name__ == '__main__':
    try:
        if len(sys.argv) < 4:
            raise ValueError('Usage: publish_xiaohongshu.py <title> <content-file> <image> [image ...]')
        content = Path(sys.argv[2]).resolve().read_text(encoding='utf-8-sig').strip()
        print(json.dumps(publish(sys.argv[1], content, sys.argv[3:]), ensure_ascii=False), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
