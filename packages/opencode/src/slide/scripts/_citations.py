import re
import json

def _ok_year(year):
    try:
        yi = int(year[:4])
        return 1850 <= yi <= 2030
    except ValueError:
        return False

def _context(text, pos, radius=100):
    start = max(0, pos - radius)
    end = min(len(text), pos + radius)
    snippet = text[start:end].strip()
    snippet = re.sub(r'[\x00-\x1f\x7f]', ' ', snippet)
    snippet = re.sub(r'\s+', ' ', snippet)
    return snippet

def extract_citations(text):
    citations = []
    full = text
    for m in re.finditer(r'PMID\s*[\s:]\s*(\d{6,9})', full, flags=re.IGNORECASE):
        citations.append({'type': 'PMID', 'id': m.group(1), 'context': _context(full, m.start())})
    for m in re.finditer(r'10\.\d{4,9}/[-._;()/:A-Za-z0-9]+', full):
        doi = m.group(0).rstrip('.')
        citations.append({'type': 'DOI', 'id': doi, 'context': _context(full, m.start())})
    pat_initial = r'([A-Z][a-z]+(?:\s*[A-Z]\.)+(?:,\s*[A-Z][a-z]+(?:\s*[A-Z]\.)+)*)(?:\s*et\s*al\.?)?\s*[\(,]\s*(\d{4})'
    for m in re.finditer(pat_initial, full):
        author = m.group(1).strip(); year = m.group(2)
        if _ok_year(year):
            citations.append({'type': 'AUTHOR_YEAR', 'id': f'{author}, {year}', 'context': _context(full, m.start())})
    pat_amp = r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:\s*&\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)*),\s*(\d{4})'
    for m in re.finditer(pat_amp, full):
        author = m.group(1).strip(); year = m.group(2)
        if _ok_year(year):
            citations.append({'type': 'AUTHOR_YEAR', 'id': f'{author}, {year}', 'context': _context(full, m.start())})
    known = r'(?:SEER|GLOBOCAN|Up[- ]to[- ]date|Harrison|Sabiston|Junqueira|PubMed|JAMA|Lancet|NEJM|Nature|Science|Cell|BMJ|Bruix|Shimbo|Doku|Boulestreau|McQueen|Mancia|Born|Tintinalli|Anderson|Hamilton)'
    pat_src = known + r'(?:[A-Za-z0-9\s\-\.:]?)\s*\((\d{4})[a-z]?\)'
    for m in re.finditer(pat_src, full, flags=re.IGNORECASE):
        src = m.group(0).strip(); year = m.group(1)
        if _ok_year(year):
            citations.append({'type': 'SOURCE_YEAR', 'id': f'{src}, {year}', 'context': _context(full, m.start())})
    for m in re.finditer(r'\((SEER\s+\d{4}|GLOBOCAN(?:\s+\d{4})?)\)', full, flags=re.IGNORECASE):
        citations.append({'type': 'DATA_SOURCE', 'id': m.group(1).strip().upper(), 'context': _context(full, m.start())})
    for m in re.finditer(r'Fonte\s*:\s*([A-Za-z][A-Za-z\s\-.:]+)', full, flags=re.IGNORECASE):
        src = m.group(1).strip().rstrip('. ')
        citations.append({'type': 'FONT_SOURCE', 'id': src, 'context': _context(full, m.start())})
    seen = set(); unique = []
    for c in citations:
        key = (c['type'], c['id'])
        if key not in seen:
            seen.add(key); unique.append(c)
    return unique

if __name__ == '__main__':
    import sys
    infile = sys.argv[1]
    outfile = sys.argv[2] if len(sys.argv) > 2 else None
    sample = open(infile, encoding='utf-8', errors='replace').read()
    result = extract_citations(sample)
    if outfile:
        with open(outfile, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"Wrote {len(result)} citations to {outfile}")
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
