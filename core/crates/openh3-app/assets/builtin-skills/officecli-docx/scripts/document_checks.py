"""Read-only DOCX checks using standard OOXML, independent of OfficeCLI output."""
import argparse
from collections import Counter
from pathlib import Path
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def xml_part(package, name):
    return ET.fromstring(package.read(name))


def is_page_instruction(instruction):
    return re.match(r'^\s*PAGE(?:\s|$)', instruction, re.IGNORECASE) is not None


def has_page_field(root):
    instructions = []
    for element in root.iter():
        if element.tag == W + 'fldSimple' and is_page_instruction(element.get(W + 'instr', '')):
            return True
        if element.tag == W + 'fldChar':
            kind = element.get(W + 'fldCharType')
            if kind == 'begin':
                instructions.append([])
            elif kind == 'end' and instructions:
                if is_page_instruction(''.join(instructions.pop())):
                    return True
        elif element.tag == W + 'instrText' and instructions:
            instructions[-1].append(element.text or '')
    return False


def check_page(package, required, reason):
    if not required:
        if not reason.strip():
            raise ValueError('Supply the verified reason page numbering is not required')
        return f'PAGE NOT REQUIRED: {reason}'
    document = xml_part(package, 'word/document.xml')
    references = {node.get(R + 'id') for tag in ('headerReference', 'footerReference') for node in document.iter(W + tag)}
    parts = ['word/document.xml']
    if references:
        relationships = xml_part(package, 'word/_rels/document.xml.rels')
        resolved = set()
        for relation in relationships:
            if relation.get('Id') not in references:
                continue
            if relation.get('TargetMode') == 'External' or relation.get('Type', '').rsplit('/', 1)[-1] not in ('header', 'footer'):
                raise ValueError('Invalid header/footer relationship')
            target = relation.get('Target', '')
            if not target:
                raise ValueError('Header/footer relationship has no target')
            parts.append(posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'word/' + target))
            resolved.add(relation.get('Id'))
        if resolved != references:
            raise ValueError('Unresolved header/footer relationship')
    if not any(has_page_field(xml_part(package, name)) for name in parts):
        raise ValueError('Required live PAGE field is missing or incomplete')
    return 'PAGE structure OK (pagination and cached display still require preview)'


def check_protection(package):
    settings = xml_part(package, 'word/settings.xml')
    protection = settings.find(W + 'documentProtection')
    if protection is None or protection.get(W + 'edit') != 'forms' or protection.get(W + 'enforcement', '').lower() not in ('1', 'true', 'on'):
        raise ValueError('Forms protection is not enforced in word/settings.xml')
    return 'Forms protection enforced (verify intended fields remain fillable in the target viewer)'


def numeric_keys(text):
    keys = set()
    for match in re.finditer(r'\[([0-9]+(?:\s*(?:,|[-\u2013\u2014])\s*[0-9]+)*)\]', text):
        for item in match.group(1).split(','):
            bounds = re.split(r'[-\u2013\u2014]', item)
            start, end = int(bounds[0]), int(bounds[-1])
            if start < 1 or end < start or end - start > 10000:
                raise ValueError(f'Unsupported citation range: {match.group(0)}')
            keys.update(range(start, end + 1))
    return keys


def check_citations(document, heading):
    body = document.find(W + 'body')
    paragraphs = [''.join(node.text or '' for node in p.iter(W + 't')).strip() for p in body.iter(W + 'p')]
    boundaries = [i for i, text in enumerate(paragraphs) if text.casefold() == heading.strip().casefold()]
    if len(boundaries) != 1:
        raise ValueError('Expected exactly one bibliography heading; specify its exact paragraph text')
    boundary = boundaries[0]
    cited = numeric_keys('\n'.join(paragraphs[:boundary]))
    labels = [int(match.group(1)) for text in paragraphs[boundary + 1:] if (match := re.match(r'^\[([0-9]+)\]\s*\S', text))]
    if not cited or not labels:
        raise ValueError('No explicit numeric citations or reference labels; this check cannot validate this citation style')
    duplicate = sorted(key for key, count in Counter(labels).items() if count > 1)
    if duplicate:
        raise ValueError(f'Duplicate bibliography keys: {duplicate}')
    missing = sorted(cited - set(labels))
    if missing:
        raise ValueError('Citations without bibliography entries: ' + ', '.join(f'[{key}]' for key in missing))
    return f'IEEE citation keys OK ({len(cited)} cited keys; {len(labels)} references; main document text only)'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    page = commands.add_parser('page', help='Verify a live PAGE field only when numbering is required')
    page.add_argument('file', type=Path)
    requirement = page.add_mutually_exclusive_group(required=True)
    requirement.add_argument('--required', action='store_true')
    requirement.add_argument('--not-required-reason')
    protection = commands.add_parser('protection', help='Verify forms mode and OOXML enforcement')
    protection.add_argument('file', type=Path)
    citations = commands.add_parser('citations', help='Match explicit IEEE numeric keys to a final bibliography section')
    citations.add_argument('file', type=Path)
    citations.add_argument('--bibliography-heading', required=True)
    args = parser.parse_args()
    try:
        with zipfile.ZipFile(args.file) as package:
            document = xml_part(package, 'word/document.xml')
            if document.tag != W + 'document' or document.find(W + 'body') is None:
                raise ValueError('word/document.xml has no Word document body')
            if args.command == 'page':
                result = check_page(package, args.required, args.not_required_reason or '')
            elif args.command == 'protection':
                result = check_protection(package)
            else:
                result = check_citations(document, args.bibliography_heading)
        print(result)
        return 0
    except (OSError, KeyError, ValueError, ET.ParseError, zipfile.BadZipFile) as error:
        print(f'REJECT: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
