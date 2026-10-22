import sys
import os
import json
import warnings
warnings.filterwarnings("ignore")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _citations

try:
    import fitz  # PyMuPDF
    HAS_FITZ = True
except ImportError:
    HAS_FITZ = False

if not HAS_FITZ:
    import PyPDF2

def extract_pdf_outline(path: str) -> list:
    outlines = []
    if HAS_FITZ:
        doc = fitz.open(str(path))
        toc = doc.get_toc()
        for entry in toc:
            if len(entry) == 3:
                outlines.append(f"{'  ' * (entry[0]-1)}- {entry[1]}")
    return outlines

def extract_pdf_text(path: str) -> str:
    p = Path(path)
    text_parts = []
    if HAS_FITZ:
        doc = fitz.open(str(p))
        for page_num, page in enumerate(doc):
            text_parts.append(f"--- Page {page_num + 1} ---")
            text_parts.append(page.get_text())
    else:
        with open(str(p), 'rb') as f:
            reader = PyPDF2.PdfReader(f)
            for page_num, page in enumerate(reader.pages):
                text_parts.append(f"--- Page {page_num + 1} ---")
                text_parts.append(page.extract_text() or "")
    return "\n".join(text_parts)

from pathlib import Path  # ensure available for extract_pdf_text above

if __name__ == "__main__":
    path = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else "extracted.md"
    output_lines = [f"Extracting: {path}"]
    output_lines.append("\n=== OUTLINE (TABLE OF CONTENTS) ===")
    try:
        outline = extract_pdf_outline(path)
        output_lines.append("\n".join(outline))
    except Exception as e:
        output_lines.append(f"Could not get outline: {e}")
    output_lines.append("\n\n=== FULL TEXT ===")
    text = extract_pdf_text(path)
    output_lines.append(text)

    output_lines.append("\n\n=== CITATIONS (JSON) ===")
    citations = _citations.extract_citations(text)
    output_lines.append(json.dumps(citations, ensure_ascii=False, indent=2))

    with open(out_file, "w", encoding="utf-8") as f:
        f.write("\n".join(output_lines))
    print(f"Done. Output written to {out_file} | citations: {len(citations)}")
