"""Local-only text extraction. Install pypdf using scripts/kompendium-requirements.txt."""
import json
import sys
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
if reader.is_encrypted and not reader.decrypt(""):
    raise SystemExit("PDF requires a password; provide a readable text-layer copy.")
pages = []
for index, page in enumerate(reader.pages, 1):
    # Layout mode preserves column/table spacing for the mandatory human review.
    text = page.extract_text(extraction_mode="layout") or ""
    pages.append({"pdfPage": index, "text": text.strip()})
json.dump(pages, sys.stdout, ensure_ascii=False)
