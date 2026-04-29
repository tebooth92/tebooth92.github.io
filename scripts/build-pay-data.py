#!/usr/bin/env python3
"""Build pay-data.json from sources.

Inputs:
  --vhia-source        Path to a JSON file or HTML containing the VHIA codes block.
                       If pointed at index.html, looks for <script id="vhia-data">.
  --mh-source          Path to the Mental Health Salary Circular .xlsx
  --out                Output path (default: ./pay-data.json)

Schema:
  metadata: { version, generatedAt, agreements, sources, ... }
  codes: keyed by compound id (VHIA:CODE / MH:CODE) with code, agreement, description,
         dateRanges (each: startDate, endDate, components: [{name, amount}], sourceLabel)
  qualificationAllowances: { sheetSubgroup: { sectionLabel, items: [{name, level, rates}] } }

Mental Health rates are weekly per FFPPOA (From the First Pay Period On or After). Hourly rates
are derived as weekly / 38 (Victorian nursing/AHP standard). Casual = base + 25% loading
(verify against EBA before relying on it). Only Laundry, Uniform, and Qualification allowances
are surfaced; Shift, Change of Roster, On Call, Meal, Leave Loading are excluded by design.
"""
import argparse, json, re, os, sys
from datetime import date, timedelta

DATE_RE = re.compile(r'FFPPOA\s+(\d+\s+\w+\s+\d{4})', re.IGNORECASE)
MONTHS = {m.lower(): i+1 for i, m in enumerate(['January','February','March','April','May','June','July','August','September','October','November','December'])}
HRS_PER_WEEK = 38

def parse_ffppoa(h):
    if not isinstance(h, str): return None
    m = DATE_RE.search(h)
    if not m: return None
    p = m.group(1).split()
    try: return date(int(p[2]), MONTHS[p[1].lower()], int(p[0]))
    except: return None

def to_hourly(w): return round(w / HRS_PER_WEEK, 5) if isinstance(w, (int, float)) else None

def load_vhia_data(src_path):
    with open(src_path) as f: txt = f.read()
    if src_path.endswith('.json'):
        return json.loads(txt)
    m = re.search(r'<script id="vhia-data" type="application/json">\s*(.*?)\s*</script>', txt, re.DOTALL)
    if not m: raise SystemExit('No vhia-data block found in ' + src_path)
    return json.loads(m.group(1))

def parse_rate_sheet(ws, category, has_commuted=False, excluded=None):
    """Parse a rate sheet. If `excluded` is a list, append entries describing any
    paycode that appears in the sheet but cannot be rated cleanly (no numeric
    FFPPOA values, "See Column I" placeholders, etc.). Such codes are intentionally
    omitted from the output to keep the calculator unambiguous."""
    if excluded is None: excluded = []
    rows = list(ws.iter_rows(values_only=True))
    headers = rows[0]
    date_cols = []
    i = 0
    while i < len(headers):
        d = parse_ffppoa(headers[i])
        if d:
            cc = i+1 if has_commuted and i+1 < len(headers) and isinstance(headers[i+1], str) and 'commuted' in headers[i+1].lower() else None
            date_cols.append((i, d, headers[i], cc))
        i += 1
    date_cols.sort(key=lambda x: x[1])
    codes = {}; cur_group = None
    for row in rows[1:]:
        if not row or row[0] is None: continue
        cls = str(row[0]).strip() if row[0] else ''
        pc = str(row[1]).strip() if row[1] else ''
        if not pc:
            cur_group = cls; continue
        if not re.match(r'^[A-Z]{1,3}\d', pc): continue
        # Inspect FFPPOA cells to determine whether this row has any usable rate
        ffppoa_values = [row[col] for col, _, _, _ in date_cols if col < len(row)]
        numeric_count = sum(1 for v in ffppoa_values if isinstance(v, (int, float)))
        see_col_i = any(isinstance(v, str) and 'see column' in v.lower() for v in ffppoa_values)
        if numeric_count == 0:
            reason = ('"See Column I" placeholder; rate equals award' if see_col_i
                      else 'No FFPPOA rate published in this circular')
            if 'aged care' in cls.lower():
                reason = 'Aged Care Employees only; no rate published in this circular'
            excluded.append({'code': pc, 'sheet': ws.title, 'group': cur_group, 'classification': cls, 'reason': reason})
            continue
        if pc not in codes:
            codes[pc] = {'code': pc, 'agreement': 'Mental Health',
                'description': f"{pc} - {cls}", 'category': category, 'group': cur_group,
                'rateBasis': 'weekly', 'hoursPerWeek': HRS_PER_WEEK, 'dateRanges': []}
        for idx, (col, eff, label, cc) in enumerate(date_cols):
            v = row[col]
            if not isinstance(v, (int, float)): continue
            ed = None
            for ni in range(idx+1, len(date_cols)):
                nv = row[date_cols[ni][0]]
                if isinstance(nv, (int, float)):
                    ed = date_cols[ni][1] - timedelta(days=1); break
            weekly_base = round(float(v), 4)
            comps = [
                {'name': 'Base Pay Rate', 'amount': to_hourly(v)},
                {'name': 'Casual Rate', 'amount': round(to_hourly(v) * 1.25, 5)},
            ]
            range_extras = {'weeklyBaseRate': weekly_base}
            if cc is not None:
                cv = row[cc]
                if isinstance(cv, (int, float)):
                    comps.append({'name': 'Commuted Allowance', 'amount': to_hourly(cv)})
                    range_extras['weeklyCommutedAllowance'] = round(float(cv), 4)
            codes[pc]['dateRanges'].append({
                'startDate': eff.isoformat(),
                'endDate': ed.isoformat() if ed else '9999-12-31',
                'components': comps, 'sourceLabel': label,
                **range_extras})
    return codes

def find_date_cols_in_row(row):
    return [(i, parse_ffppoa(c), c) for i, c in enumerate(row) if isinstance(c, str) and parse_ffppoa(c)]

def parse_uniform_laundry_qual(ws):
    """Filtered to Laundry, Uniform, Qualification only."""
    rows = list(ws.iter_rows(values_only=True))
    date_cols = []
    section = None; sheet_subgroup = None; qual_sub = None
    uniform = {}; laundry = {}; qualification = {}
    pat_uniform = re.compile(r'^uniform allowance\s*$', re.IGNORECASE)
    pat_laundry = re.compile(r'^laundry allowance\s*$', re.IGNORECASE)
    pat_qual = re.compile(r'qualification\s+allowance', re.IGNORECASE)
    pat_higher = re.compile(r'higher education recognition allowance', re.IGNORECASE)
    pat_other = re.compile(r'(shift allowance|change of roster|change of ward|on call|on-call|meal allowance|leave loading|telephone|sole allowance|senior allowance|experience payment|nauseous|interpreter|first aid|change of shift|certificate iv tae|sleepover)', re.IGNORECASE)
    pat_subgroup = re.compile(r'(registered psychiatric|mental health officer|mental health professional|ahp\d|support service|management and admin|lived experience)', re.IGNORECASE)
    for row in rows:
        if not row: continue
        first = row[0]
        if sum(1 for c in row if isinstance(c, str) and DATE_RE.search(c)) >= 2:
            date_cols = find_date_cols_in_row(row); continue
        has_nums = any(isinstance(c, (int, float)) for c in row[1:])
        if isinstance(first, str) and not has_nums:
            text = first.strip()
            if pat_other.search(text): section = None; qual_sub = None; continue
            if pat_uniform.match(text): section = 'uniform'; qual_sub = None; uniform.setdefault(sheet_subgroup, {}); continue
            if pat_laundry.match(text): section = 'laundry'; qual_sub = None; laundry.setdefault(sheet_subgroup, {}); continue
            if pat_qual.search(text) or pat_higher.search(text):
                section = 'qualification'; qual_sub = None
                qualification.setdefault(sheet_subgroup, {'sectionLabel': text, 'items': []})
                continue
            if pat_subgroup.search(text):
                sheet_subgroup = text; section = None; qual_sub = None; continue
            if section == 'qualification': qual_sub = text
            continue
        if section is None or not date_cols or not isinstance(first, str): continue
        rates = []
        for col, eff, label in date_cols:
            v = row[col] if col < len(row) else None
            if isinstance(v, (int, float)):
                rates.append({'startDate': eff.isoformat(), 'amount': round(float(v), 4)})
        if not rates: continue
        if section == 'uniform': uniform[sheet_subgroup][first.strip()] = rates
        elif section == 'laundry': laundry[sheet_subgroup][first.strip()] = rates
        elif section == 'qualification':
            qualification[sheet_subgroup]['items'].append({'name': first.strip(), 'level': qual_sub, 'rates': rates})
    return uniform, laundry, qualification

def allowance_subgroup_for(code_data):
    g = (code_data.get('group') or '').lower()
    cat = (code_data.get('category') or '').lower()
    if 'mental health officer' in g: return 'Mental Health Officers'
    if any(k in g for k in ['registered psychiatric', 'psychiatric enrolled', 'ruson', 'indigenous health']):
        return 'Registered Psychiatric Nurses & Psychiatric Enrolled Nurses'
    if g.startswith('ahp -') or ('ahp' in cat and 'mgr' not in g): return 'AHP1 Classification'
    if 'support service' in g or g.startswith('level '): return 'Support Services Classifiations'
    if 'manager' in g: return 'AHP1 Classification'
    return None

def find_active_rate(rates, start_date):
    active = None
    for r in rates:
        if r['startDate'] <= start_date: active = r['amount']
        else: break
    return active

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vhia-source', required=True)
    ap.add_argument('--mh-source', required=True)
    ap.add_argument('--out', default='pay-data.json')
    ap.add_argument('--pretty', action='store_true')
    args = ap.parse_args()
    try: import openpyxl
    except ImportError: sys.exit('pip install openpyxl')
    wb = openpyxl.load_workbook(args.mh_source, data_only=True)

    excluded = []
    mh = parse_rate_sheet(wb['RPNs,PSENs, MHOs'], 'RPN/PSEN/MHO', excluded=excluded)
    mh_com = parse_rate_sheet(wb['Wages - Commuted'], 'RPN/PSEN/MHO (Commuted)', has_commuted=True, excluded=excluded)
    mh_ahp = parse_rate_sheet(wb['AHP, Managers, Support'], 'AHP/Managers/Support', excluded=excluded)
    # De-duplicate, and drop any code that was successfully rated elsewhere
    # (a paycode can appear in multiple rows, some unrated and some rated).
    rated_codes = set(mh.keys()) | set(mh_com.keys()) | set(mh_ahp.keys())
    seen = set(); excluded_unique = []
    for e in excluded:
        if e['code'] in rated_codes: continue
        if e['code'] not in seen:
            seen.add(e['code']); excluded_unique.append(e)
    excluded = excluded_unique
    for code, data in mh_com.items():
        if code in mh:
            ex = {dr['startDate']: dr for dr in mh[code]['dateRanges']}
            for dr in data['dateRanges']: ex[dr['startDate']] = dr
            mh[code]['dateRanges'] = sorted(ex.values(), key=lambda x: x['startDate'])
            mh[code]['hasCommuted'] = True
        else:
            data['hasCommuted'] = True; mh[code] = data
    for code, data in mh_ahp.items():
        if code in mh:
            ex = {dr['startDate']: dr for dr in mh[code]['dateRanges']}
            for dr in data['dateRanges']: ex.setdefault(dr['startDate'], dr)
            mh[code]['dateRanges'] = sorted(ex.values(), key=lambda x: x['startDate'])
        else: mh[code] = data

    u_a, l_a, q_a = parse_uniform_laundry_qual(wb['Allowances - RPNs, PSEN, MHOs'])
    u_b, l_b, q_b = parse_uniform_laundry_qual(wb['Allowances -AHP, Mgrs, Support '])
    uniform = {**u_a, **u_b}; laundry = {**l_a, **l_b}; qualification = {**q_a, **q_b}

    vhia_raw = load_vhia_data(args.vhia_source)

    # First, attach Uniform/Laundry allowances to MH date ranges based on group
    for code, data in mh.items():
        sub = allowance_subgroup_for(data)
        data['allowanceSubgroup'] = sub
        if sub:
            u = uniform.get(sub, {}).get('Weekly') or uniform.get(sub, {}).get('Per Week') or uniform.get(sub, {}).get('Amount per week')
            l = laundry.get(sub, {}).get('Weekly') or laundry.get(sub, {}).get('Per Week') or laundry.get(sub, {}).get('Amount per week')
            for dr in data['dateRanges']:
                sd = dr['startDate']
                if u:
                    a = find_active_rate(u, sd)
                    if a is not None: dr['components'].append({'name': 'Uniform Allowance', 'amount': to_hourly(a)})
                if l:
                    a = find_active_rate(l, sd)
                    if a is not None: dr['components'].append({'name': 'Laundry Allowance', 'amount': to_hourly(a)})

    # Merge: one entry per code. For overlap codes, close any open VHIA range the day before
    # the earliest MH range starts, then append MH ranges chronologically.
    unified = {}
    for code, data in vhia_raw['codes'].items():
        unified[code] = {
            'code': code,
            'description': data.get('description', ''),
            'level': data.get('level', ''),
            'rateBasis': 'hourly',
            'dateRanges': list(data.get('dateRanges', [])),
        }
    for code, mh_data in mh.items():
        mh_ranges = sorted(mh_data['dateRanges'], key=lambda r: r['startDate'])
        if not mh_ranges: continue
        earliest_mh = mh_ranges[0]['startDate']
        prior_day = (date.fromisoformat(earliest_mh) - timedelta(days=1)).isoformat()
        if code in unified:
            # Close any open VHIA range that overlaps the new MH ranges
            for r in unified[code]['dateRanges']:
                if r['endDate'] == '9999-12-31' or r['endDate'] >= earliest_mh:
                    if r['startDate'] < earliest_mh:
                        r['endDate'] = prior_day
            # Append MH ranges
            unified[code]['dateRanges'].extend(mh_ranges)
            # Carry forward MH-specific metadata if not already present
            unified[code].setdefault('category', mh_data.get('category'))
            unified[code].setdefault('group', mh_data.get('group'))
            if mh_data.get('hasCommuted'): unified[code]['hasCommuted'] = True
            if mh_data.get('allowanceSubgroup'): unified[code]['allowanceSubgroup'] = mh_data['allowanceSubgroup']
            unified[code]['hoursPerWeek'] = mh_data.get('hoursPerWeek', HRS_PER_WEEK)
        else:
            # MH-only code (new under the new EBA)
            unified[code] = {
                'code': code,
                'description': mh_data.get('description', ''),
                'category': mh_data.get('category'),
                'group': mh_data.get('group'),
                'rateBasis': 'mixed',  # may have weekly+hourly components
                'hoursPerWeek': mh_data.get('hoursPerWeek', HRS_PER_WEEK),
                'allowanceSubgroup': mh_data.get('allowanceSubgroup'),
                'hasCommuted': mh_data.get('hasCommuted', False),
                'dateRanges': mh_ranges,
            }
        # Sort all ranges chronologically and drop ranges that became invalid (start > end)
        unified[code]['dateRanges'] = [r for r in sorted(unified[code]['dateRanges'], key=lambda x: x['startDate']) if r['startDate'] <= r['endDate']]

    pay_data = {
        'metadata': {
            'version': '2.1.0',
            'excludedCodes': excluded,
            'excludedCodesNote': 'Classifications that appear in the source spreadsheet but were excluded from the calculator due to ambiguity (no FFPPOA rate, "See Column I" placeholder, or Aged Care-only with no published rate). Listed here for transparency.',
            'generatedAt': date.today().isoformat(),
            'generator': 'scripts/build-pay-data.py',
            'agreements': ['Victorian public health (VHIA-negotiated)', 'Mental Health Salary Circular 880'],
            'sources': {
                'VHIA': vhia_raw.get('metadata', {}),
                'Mental Health': {
                    'circular': '880 - Updated 27 March 2026',
                    'agreement': 'Victorian Public Mental Health Services Enterprise Agreement',
                    'hoursPerWeek': HRS_PER_WEEK,
                    'note': 'Weekly rates -> hourly via /38. Casual = base + 25%. Only Laundry, Uniform, Qualification allowances surfaced.',
                }
            },
        },
        'codes': unified,
        'qualificationAllowances': qualification,
    }
    with open(args.out, 'w') as f:
        json.dump(pay_data, f, indent=2 if args.pretty else None, separators=(',', ':') if not args.pretty else None, default=str)
    sz = os.path.getsize(args.out)
    mh_only = sum(1 for k in unified if k not in vhia_raw["codes"])
    overlap = sum(1 for k in mh if k in vhia_raw["codes"])
    print(f"{args.out}: {len(unified)} codes ({len(vhia_raw['codes'])} VHIA, {mh_only} MH-only new, {overlap} merged with new MH ranges); {sz/1024:.1f} KB")
    print(f"  excluded {len(excluded)} ambiguous MH classifications: {[e['code'] for e in excluded]}")

if __name__ == '__main__': main()
