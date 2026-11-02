#!/usr/bin/env python3
"""Build data/eoir/snapshot.json from the PUBLIC (public-domain) EOIR files.
Inputs (downloaded once; this script never fetches):
  --reps   pdftotext -layout output of the Accredited Representatives List PDF (raroster-reps.pdf)
  --orgs   pdftotext -layout output of the Recognized Organizations List PDF (raroster-orgs-reps.pdf) -> org recognition dates/status
  --cur    HTML of https://www.justice.gov/eoir/list-of-currently-disciplined-practitioners
  --prev   HTML of https://www.justice.gov/eoir/list-of-previously-disciplined-practitioners
Source: U.S. Department of Justice, EOIR. DOJ content is public domain unless marked otherwise (https://www.justice.gov/legalpolicies).
Not affiliated with or endorsed by DOJ/EOIR. Snapshot only; not a legal determination.
"""
import argparse, json, re, html, sys
from html.parser import HTMLParser

DATE = r'\d\d/\d\d/\d\d'
REP_RE = re.compile(rf'^(\S.*?)\s+({DATE})(\*?)\s+([A-Za-z]+)\s{{2,}}(\S.*?)\s+({DATE})\s+({DATE})(\*?)\s+([A-Za-z]+)\s*$')

def iso(d):
    m, dd, y = d.split('/'); return f'20{y}-{m}-{dd}' if int(y) < 70 else f'19{y}-{m}-{dd}'

def parse_reps(path):
    lines = open(path, encoding='utf8').read().split('\n')
    recs, cur = [], None
    for ln in lines:
        ln = ln.replace('\x0c', '')   # pdftotext page breaks
        m = REP_RE.match(ln)
        if m:
            cur = dict(name=m.group(1).strip(), acc_exp=iso(m.group(2)), acc_pending=bool(m.group(3)), rep_status=m.group(4),
                       org=m.group(5).strip(), org_recognized=iso(m.group(6)), org_exp=iso(m.group(7)), org_pending=bool(m.group(8)), org_status=m.group(9),
                       _os=m.start(5), _od=m.start(6), _ne=m.start(2))
            recs.append(cur); continue
        if cur is None or not ln.strip() or 'Report Last Updated' in ln or ln.startswith('Accredited') or ln.startswith('Representative') or ln.startswith('Disclaimer'):
            if not ln.strip(): cur = cur  # blank lines separate nothing reliably
            continue
        if re.match(r'^\s*[A-Z]\s*$', ln): continue          # section letter
        if re.search(r'Page \d+', ln): continue
        a = ln[:cur['_ne']].strip(); o = ln[cur['_os']:cur['_od']].strip()
        if a and not a.startswith('(Pending') and a != 'Renewal)' and a != 'Date': cur['name'] += ' ' + a
        if o and o not in ('(Pending', 'Renewal)'): cur['org'] += ' ' + o
    for r in recs:
        for k in ('_os', '_od', '_ne'): r.pop(k)
        r['dhs_only'] = '(DHS only)' in r['name']
        r['name'] = re.sub(r'\s*\(DHS only\)', '', r['name']).strip()
        r['name'] = re.sub(r'\s+', ' ', r['name']); r['org'] = re.sub(r'\s+', ' ', r['org'])
    return recs

class Rows(HTMLParser):
    def __init__(s): super().__init__(); s.rows = []; s.row = None; s.cell = None; s.links = []
    def handle_starttag(s, t, a):
        if t == 'tr': s.row = []
        elif t in ('td', 'th') and s.row is not None: s.cell = ''
    def handle_endtag(s, t):
        if t in ('td', 'th') and s.row is not None and s.cell is not None: s.row.append(re.sub(r'\s+', ' ', html.unescape(s.cell)).strip()); s.cell = None
        elif t == 'tr' and s.row is not None:
            if s.row: s.rows.append(s.row)
            s.row = None
    def handle_data(s, d):
        if s.cell is not None: s.cell += d

def parse_disc(path):
    p = Rows(); p.feed(open(path, encoding='utf8').read())
    out = []
    for r in p.rows:
        if len(r) >= 6 and r[0].lower() != 'name':
            out.append(dict(name=r[0].replace('(NEW)', '').strip(), place=r[1], immediate_suspension=r[2], final_discipline=r[3], effective=r[4], reinstated=r[5]))
    return out

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--reps'); ap.add_argument('--cur'); ap.add_argument('--prev'); ap.add_argument('--out', default='data/eoir/snapshot.json')
    ap.add_argument('--report-date', default='2026-10-25'); ap.add_argument('--cur-date', default='2026-10-26'); ap.add_argument('--prev-date', default='2026-04-23'); ap.add_argument('--taken', default='2026-11-02')
    a = ap.parse_args()
    reps = parse_reps(a.reps); cur = parse_disc(a.cur); prev = parse_disc(a.prev)
    orgs = {}
    for r in reps:
        o = orgs.setdefault(r['org'], dict(name=r['org'], recognized=r['org_recognized'], expires=r['org_exp'], pending_renewal=r['org_pending'], status=r['org_status']))
    snap = dict(
        manifest=dict(taken=a.taken, source='U.S. Department of Justice, Executive Office for Immigration Review (public domain: https://www.justice.gov/legalpolicies)',
            roster_report_date=a.report_date, roster_pages=['https://www.justice.gov/eoir/recognition-accreditation-roster-reports'],
            currently_disciplined=dict(url='https://www.justice.gov/eoir/list-of-currently-disciplined-practitioners', page_date=a.cur_date),
            previously_disciplined=dict(url='https://www.justice.gov/eoir/list-of-previously-disciplined-practitioners', page_date=a.prev_date),
            counts=dict(accredited_representatives=len(reps), organizations=len(orgs), currently_disciplined=len(cur), previously_disciplined=len(prev)),
            disclaimer='Snapshot of public EOIR lists, not a legal determination. Not endorsed by DOJ/EOIR. Re-download before relying on it.'),
        organizations=sorted(orgs.values(), key=lambda o: o['name']), representatives=reps, disciplined_current=cur, disciplined_previous=prev)
    json.dump(snap, open(a.out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(json.dumps(snap['manifest']['counts']))
