"""Publish authorized content; a click alone never proves publication."""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright


def verify_post_response(payload, content, image_count=0):
    try:
        if payload.get('errors'):
            raise ValueError('API errors')
        result = payload['data']['create_tweet']['tweet_results']['result']
        legacy = result['legacy']
        media = legacy.get('entities', {}).get('media', [])
        returned_text = legacy['full_text']
        for item in media:
            url = item.get('url', '')
            if url and returned_text.endswith(' ' + url):
                returned_text = returned_text[:-(len(url) + 1)]
        post_id = result['rest_id']
        if not isinstance(post_id, str) or not post_id.isdigit() or returned_text != content or len(media) != image_count:
            raise ValueError('post does not match requested text/media')
        return f'https://x.com/i/status/{post_id}'
    except (KeyError, TypeError, AttributeError, ValueError) as error:
        raise RuntimeError('Publication outcome unknown: no matching created post. Check existing posts before any retry.') from error


def prepare_and_publish(page, content, images):
    composer = page.locator("div[role='textbox'][data-testid='tweetTextarea_0']")
    composer.wait_for(state='visible', timeout=120000)
    composer.fill(content)
    if composer.inner_text().strip() != content:
        raise RuntimeError('Composer content mismatch; nothing submitted.')
    if images:
        page.locator("input[type='file'][data-testid='fileInput']").set_input_files(images)
        previews = page.locator("[data-testid='attachments'] [data-testid='removeMedia']")
        previews.nth(len(images) - 1).wait_for(state='visible', timeout=30000)
        if previews.count() != len(images):
            raise RuntimeError('Attachment count mismatch; nothing submitted.')
    post = page.locator("[data-testid='tweetButtonInline'], [data-testid='tweetButton']").first
    post.wait_for(state='visible', timeout=30000)
    if not post.is_enabled():
        raise RuntimeError('Post is disabled or uploads are incomplete; nothing submitted.')
    try:
        with page.expect_response(
            lambda response: urlparse(response.url).netloc in ('x.com', 'twitter.com')
            and urlparse(response.url).path.endswith('/CreateTweet')
            and response.request.method == 'POST', timeout=30000
        ) as response_info:
            post.click()
        response = response_info.value
        if not response.ok:
            raise RuntimeError('CreateTweet request failed')
        url = verify_post_response(response.json(), content, len(images))
    except Exception as error:
        raise RuntimeError('Publication outcome unknown: check existing posts before any retry.') from error
    return {'status': 'published', 'url': url}


def main():
    if len(sys.argv) < 2:
        raise ValueError('Usage: publish_x.py <post_content.txt> [image ...]')
    content = Path(sys.argv[1]).resolve().read_text(encoding='utf-8-sig').strip()
    if not content:
        raise ValueError('Post content is empty.')
    images = [str(Path(value).resolve()) for value in sys.argv[2:]]
    if len(images) > 4:
        raise ValueError('At most four images are supported by this helper.')
    for image in images:
        if not Path(image).is_file() or Path(image).stat().st_size == 0:
            raise ValueError(f'Missing or empty image: {image}')
    print('Complete login in the opened browser. The authorized post will be submitted automatically.', flush=True)
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=False)
        try:
            page = browser.new_page()
            page.goto('https://x.com/home', wait_until='domcontentloaded')
            print(json.dumps(prepare_and_publish(page, content, images)), flush=True)
        finally:
            browser.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
