#!/usr/bin/env python3
"""Read back Morph edits and inspect structure; rendered motion still needs review.

Use absolute paths for this script and the deck when invoking from another cwd.
The legacy clean-accumulation command is now a read-only inspection alias.
"""

import argparse
import json
import re
import subprocess
import sys


def _run(*args):
    """Return a bounded command result without hiding launch failures."""
    try:
        result = subprocess.run(list(args), capture_output=True, text=True,
                                encoding='utf-8', errors='replace', timeout=60)
        return result.returncode, result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        return 1, '', str(error)


def _checked_run(*args):
    rc, out, error = _run(*args)
    if rc != 0:
        raise RuntimeError(f'{args[1]} failed (exit {rc}): {error.strip()[:1000]}')
    return out


def _payload(raw):
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise RuntimeError('Inspection returned invalid JSON') from error
    if not isinstance(data, dict) or data.get('success') is False:
        raise RuntimeError('Inspection did not return a successful object')
    return data.get('data', data)


def _entry(raw, require_children=False):
    data = _payload(raw)
    if isinstance(data, dict) and 'results' in data:
        results = data['results']
        if not isinstance(results, list) or len(results) != 1:
            raise RuntimeError('Inspection must return exactly one requested entry')
        data = results[0]
    if not isinstance(data, dict) or not isinstance(data.get('format'), dict):
        raise RuntimeError('Inspection has an unknown entry schema')
    if require_children:
        if data.get('type') != 'slide':
            raise RuntimeError('Inspection did not identify a slide')
        if not isinstance(data.get('children'), list):
            raise RuntimeError('Slide inspection omitted its shape tree')
        _check_complete_container(data)
        _collect_shapes(data['children'], lambda child: None)
    return data


def _has_morph_transition(raw):
    try:
        data = _entry(raw)
        return data.get('transition', data['format'].get('transition')) == 'morph'
    except RuntimeError:
        return False


def _check_complete_container(node):
    if node.get('type') in ('slide', 'group') and 'childCount' in node:
        count = node['childCount']
        children = node.get('children', [])
        if not isinstance(count, int) or count < 0 or not isinstance(children, list) or count != len(children):
            raise RuntimeError('Shape tree is truncated; inspect with sufficient depth')


def _collect_shapes(children, callback, skip_ghosted_groups=False):
    if not isinstance(children, list):
        raise RuntimeError('Unknown shape tree schema')
    for child in children:
        if not isinstance(child, dict) or not isinstance(child.get('format'), dict):
            raise RuntimeError('Unknown shape entry schema')
        _check_complete_container(child)
        callback(child)
        if 'children' in child:
            if skip_ghosted_groups and child.get('type') == 'group' and _is_ghost(child['format'].get('x')):
                continue
            _collect_shapes(child['children'], callback, skip_ghosted_groups)


def _is_ghost(x):
    """Recognize this skill's explicit 36 cm ghost position, not a guessed canvas."""
    return isinstance(x, str) and bool(re.fullmatch(r'\s*36(?:\.0+)?\s*cm\s*', x))


def morph_clone_slide(deck, from_slide, to_slide):
    from_slide, to_slide = int(from_slide), int(to_slide)
    if min(from_slide, to_slide) < 1:
        raise RuntimeError('Slide indices must be positive')
    print(f'Cloning slide {from_slide} -> {to_slide}...')
    out = _checked_run('officecli', 'add', deck, '/', '--from', f'/slide[{from_slide}]',
                       '--index', str(to_slide - 1))
    copied = re.fullmatch(r'Copied to /slide\[(\d+)\]', out.strip())
    if not copied or int(copied.group(1)) != to_slide:
        raise RuntimeError('Clone destination unconfirmed; inspect the deck before further writes')
    _checked_run('officecli', 'set', deck, f'/slide[{to_slide}]', '--prop', 'transition=morph')
    out = _checked_run('officecli', 'get', deck, f'/slide[{to_slide}]', '--json')
    if not _has_morph_transition(out):
        raise RuntimeError(f'Transition readback failed on slide {to_slide}')
    print(f'Transition verified on slide {to_slide}; inspect the rendered transition next.')


def morph_ghost_content(deck, slide, *shapes):
    slide, shapes = int(slide), [int(s) for s in shapes]
    if slide < 1 or any(index < 1 for index in shapes):
        raise RuntimeError('Slide and shape indices must be positive')
    for index in shapes:
        path = f'/slide[{slide}]/shape[{index}]'
        _checked_run('officecli', 'set', deck, path, '--prop', 'x=36cm')
        data = _entry(_checked_run('officecli', 'get', deck, path, '--json'))
        if not _is_ghost(data['format'].get('x')):
            raise RuntimeError(f'Ghost position readback failed: {path}')
        print(f'Ghosted {path}')
    print(f'Ghosting complete: {len(shapes)} verified shapes')


def _check_unghosted(data, prev_slide):
    """Check explicitly slide-local #sN content; persistent actors are not exits."""
    unghosted = []

    def visit(child):
        name = child['format'].get('name', '')
        match = re.match(r'^(?:!!)?#s(\d+)-', str(name))
        x = child['format'].get('x')
        if match and int(match.group(1)) <= prev_slide and not _is_ghost(x):
            unghosted.append(f"{child.get('path', '?')}: name={name}, x={x}")

    _collect_shapes(data['children'], visit, skip_ghosted_groups=True)
    return unghosted


def _check_duplicates(prev_data, curr_data):
    """Return review candidates, not failures: repeated headings can be intentional."""
    def extract(data):
        boxes = []

        def visit(child):
            fmt, text = child['format'], child.get('text')
            if child.get('type') == 'textbox' and isinstance(text, str) and text.strip():
                if not _is_ghost(fmt.get('x')):
                    boxes.append((text.strip(), fmt.get('x'), fmt.get('y')))

        _collect_shapes(data['children'], visit, skip_ghosted_groups=True)
        return boxes

    previous = extract(prev_data)
    return [box[0] for box in extract(curr_data) if box in previous]


def morph_verify_slide(deck, slide, require_morph=True):
    slide = int(slide)
    print(f'Verifying slide {slide}...')
    try:
        if slide < 1:
            raise RuntimeError('Slide index must be positive')
        raw = _checked_run('officecli', 'get', deck, f'/slide[{slide}]', '--depth', '32', '--json')
        current = _entry(raw, require_children=True)
        if slide > 1 and require_morph and not _has_morph_transition(raw):
            raise RuntimeError('Missing transition=morph')
        old_content = _check_unghosted(current, slide - 1)
        if old_content:
            raise RuntimeError('Unhidden slide-local content: ' + '; '.join(old_content))
        if slide > 1:
            raw = _checked_run('officecli', 'get', deck, f'/slide[{slide - 1}]', '--depth', '32', '--json')
            previous = _entry(raw, require_children=True)
            duplicates = _check_duplicates(previous, current)
            if duplicates:
                print(f'Review {len(duplicates)} repeated text/position pairs against the scene plan; '
                      'repetition alone is not an error.')
        print(f'Slide {slide} structural checks passed; visual review is still required.')
        return True
    except RuntimeError as error:
        print(f'Slide {slide} verification failed: {error}')
        return False


def inspect_ghosts(deck):
    raw = _checked_run('officecli', 'query', deck, 'shape[x>=34cm]', '--json')
    data = _payload(raw)
    if not isinstance(data, dict) or not isinstance(data.get('results'), list):
        raise RuntimeError('Ghost query returned an unknown results schema')
    results = data['results']
    if any(not isinstance(shape, dict) or not isinstance(shape.get('format'), dict) for shape in results):
        raise RuntimeError('Ghost query returned an invalid shape')
    print(f'Found {len(results)} off-slide shapes. Compare with the actor lifecycle plan; '
          'count alone cannot establish a defect. No shapes were removed.')
    for shape in results:
        print(f"  {shape.get('path', '?')}: {shape.get('format', {}).get('name', '?')}")
    return results


def clean_ghost_accumulation(deck, threshold=50):
    """Legacy inspection-only alias; never delete animation pairs by count."""
    inspect_ghosts(deck)
    return 0


def morph_final_check(deck, morph_slides=None):
    try:
        outline = _checked_run('officecli', 'view', deck, 'outline')
        first_line = outline.strip().splitlines()[0] if outline.strip() else ''
        match = re.fullmatch(r'(?:File: .* \| )?(\d+)\s+slides?', first_line)
        if not match or int(match.group(1)) < 1:
            raise RuntimeError('Could not establish slide count from outline')
        total = int(match.group(1))
        targets = set(range(2, total + 1)) if morph_slides is None else set(morph_slides)
        if any(not isinstance(index, int) or index < 2 or index > total for index in targets):
            raise RuntimeError('Morph destinations must be existing slide numbers after slide 1')
        inspect_ghosts(deck)
        results = [morph_verify_slide(deck, index, require_morph=index in targets) for index in range(1, total + 1)]
        if not all(results):
            return False
        print(f'All {total} slides passed structural checks. '
              'Render and review every transition before claiming animation quality.')
        return True
    except RuntimeError as error:
        print(f'Deck verification failed: {error}')
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for command in ('clone', 'ghost', 'verify', 'final-check', 'inspect-ghosts', 'clean-accumulation'):
        child = sub.add_parser(command)
        child.add_argument('deck')
        if command == 'clone':
            child.add_argument('from_slide', type=int)
            child.add_argument('to_slide', type=int)
        elif command in ('ghost', 'verify'):
            child.add_argument('slide', type=int)
        if command == 'ghost':
            child.add_argument('shapes', nargs='+', type=int)
        if command == 'final-check':
            child.add_argument('--morph-slides', help='Comma-separated destination slides; default: all after 1. Use none for no Morph.')
    args = parser.parse_args()
    try:
        if args.command == 'clone':
            morph_clone_slide(args.deck, args.from_slide, args.to_slide)
        elif args.command == 'ghost':
            morph_ghost_content(args.deck, args.slide, *args.shapes)
        elif args.command == 'verify':
            return 0 if morph_verify_slide(args.deck, args.slide) else 1
        elif args.command == 'final-check':
            targets = None
            if args.morph_slides is not None:
                try:
                    targets = [] if args.morph_slides == 'none' else [int(value) for value in args.morph_slides.split(',')]
                except ValueError as error:
                    raise RuntimeError('Invalid --morph-slides list') from error
            return 0 if morph_final_check(args.deck, targets) else 1
        else:
            inspect_ghosts(args.deck)
        return 0
    except RuntimeError as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
