#!/usr/bin/env python3
"""Render a candidate config; apply it only after backup and nginx -t."""
import argparse
from pathlib import Path
import re

START, END = '# BEGIN agent-workboard', '# END agent-workboard'


def render(source, template):
    # The actual DSH location is the authority for the shared Basic account file and realm.
    blocks = re.findall(r'location\s+\^~\s+/dsh/\s*\{([^{}]*)\}', source)
    if len(blocks) != 1:
        raise ValueError('Expected one existing /dsh/ location')
    realm = re.search(r'auth_basic\s+([^;\n]+);', blocks[0])
    password = re.search(r'auth_basic_user_file\s+([^;\n]+);', blocks[0])
    if not realm or not password or realm[1].strip() == 'off':
        raise ValueError('Existing DSH Basic authentication is required')
    if START in source:
        if source.count(START) != 1 or source.count(END) != 1:
            raise ValueError('Ambiguous managed AW block')
        source = re.sub(re.escape(START) + r'.*?' + re.escape(END) + r'\n?', '', source, flags=re.S)
    if re.search(r'location\s+(?:=\s+|\^~\s+)?/aw(?:/|\s)', source):
        raise ValueError('An existing /aw location is not owned by this deployment')
    anchors = list(re.finditer(r'(?m)^\s*location\s*=\s*/dsh\s*\{', source))
    if len(anchors) != 1:
        raise ValueError('Expected one /dsh canonical location as insertion anchor')
    snippet = re.sub(r'auth_basic\s+[^;\n]+;', lambda _: 'auth_basic ' + realm[1] + ';', template)
    snippet = re.sub(r'auth_basic_user_file\s+[^;\n]+;', lambda _: 'auth_basic_user_file ' + password[1] + ';', snippet)
    at = anchors[0].start()
    return source[:at] + '\n' + START + '\n' + snippet + '\n' + END + '\n' + source[at:]


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.source.resolve() == a.output.resolve():
        raise ValueError('Render a separate candidate; do not overwrite the live file')
    a.output.write_text(render(a.source.read_text(), (Path(__file__).parent / 'nginx.conf.example').read_text()))
    a.output.chmod(0o600)
    print('Rendered candidate with the existing DSH Basic account file; live config unchanged.')
