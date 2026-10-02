"""Local, resumable OCR. Adds invisible text to a copy; never modifies the input PDF."""
import argparse
import concurrent.futures
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import statistics
from pypdf import PdfReader, PdfWriter, Transformation

def read_tsv_rows(path):
    # Tesseract writes literal OCR punctuation to TSV fields. A stray quote in
    # an OCR word must not consume subsequent rows as one multiline field.
    with path.open(newline='') as handle:
        return list(csv.DictReader(handle, delimiter='\t', quoting=csv.QUOTE_NONE))

parser = argparse.ArgumentParser()
parser.add_argument('--pdf', required=True)
parser.add_argument('--out-dir', required=True)
parser.add_argument('--tessdata', required=True)
parser.add_argument('--title', required=True)
parser.add_argument('--workers', type=int, default=4)
parser.add_argument('--dpi', type=int, default=250)
args = parser.parse_args()
source = Path(args.pdf).resolve()
out = Path(args.out_dir).resolve()
private_root = Path(__file__).resolve().parent.parent / 'private-kompendium'
if not out.is_relative_to(private_root):
    raise SystemExit('OCR output must be inside ignored private-kompendium/.')
out.mkdir(parents=True, exist_ok=True)
os.chmod(out, 0o700)
parts = out / 'pages'
parts.mkdir(exist_ok=True)
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
manifest = {'sourceSha256': source_hash, 'dpi': args.dpi, 'language': 'pol+eng',
            'polModelSha256': hashlib.sha256((Path(args.tessdata) / 'pol.traineddata').read_bytes()).hexdigest()}
manifest_path = out / 'manifest.json'
if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
    raise SystemExit('Existing OCR output belongs to a different PDF or OCR configuration.')
manifest_path.write_text(json.dumps(manifest, indent=2))
original = PdfReader(source)
if original.is_encrypted and not original.decrypt(''):
    raise SystemExit('Password-protected input requires a readable copy.')

def recognize(number):
    prefix = parts / f'{number:04d}'
    cached = prefix.with_suffix('.json')
    if cached.exists() and prefix.with_suffix('.pdf').exists():
        return json.loads(cached.read_text())
    subprocess.run(['pdftoppm', '-f', str(number), '-l', str(number), '-r', str(args.dpi), '-png', '-singlefile', str(source), str(prefix)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90)
    try:
        subprocess.run(['tesseract', str(prefix.with_suffix('.png')), str(prefix), '--tessdata-dir', args.tessdata,
                        '-l', 'pol+eng', '--dpi', str(args.dpi), '-c', 'textonly_pdf=1', 'pdf', 'txt', 'tsv'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=180,
                       env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
    finally:
        prefix.with_suffix('.png').unlink(missing_ok=True)
    rows = read_tsv_rows(prefix.with_suffix('.tsv'))
    height = int(rows[0]['height'])
    words = [r for r in rows if r['text'].strip() and float(r['conf']) >= 0]
    confidence = statistics.mean(float(r['conf']) for r in words) if words else 0
    candidates = [r['text'] for r in words if re.fullmatch(r'\d{1,3}', r['text']) and int(r['top']) > height * .89]
    text = prefix.with_suffix('.txt').read_text().strip()
    result = {'pdfPage': number, 'bookPage': candidates[0] if len(candidates) == 1 else None,
              'section': '', 'exclude': len(text) < 30, 'text': text,
              'ocrMeanConfidence': round(confidence, 2), 'pageNumberCandidates': candidates,
              'needsReview': confidence < 85 or len(candidates) != 1}
    cached.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result

pages = []
with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 6))) as pool:
    futures = [pool.submit(recognize, i) for i in range(1, len(original.pages) + 1)]
    for future in concurrent.futures.as_completed(futures):
        pages.append(future.result())
        if len(pages) % 10 == 0 or len(pages) == len(futures):
            print(f'OCR: {len(pages)}/{len(futures)} pages', flush=True)
pages.sort(key=lambda page: page['pdfPage'])
# Prefer publisher-provided PDF labels to OCR guesses of numerals in tables/artwork.
source_labels = original.page_labels if original.trailer['/Root'].get('/PageLabels') else None
if source_labels:
    for page, label in zip(pages, source_labels):
        page['bookPage'] = label if re.fullmatch(r'\d+|[ivxlcdmIVXLCDM]+', label) else None
        page['pageLabelSource'] = 'original_pdf_metadata'
        page['needsReview'] = page['ocrMeanConfidence'] < 85
# Keep page artwork/watermarks in the PDF, but omit the decorative header/footer
# bands from retrieval text. TSV ordering preserves Tesseract's column blocks.
for page in pages:
    rows = read_tsv_rows(parts / f"{page['pdfPage']:04d}.tsv")
    height, width = int(rows[0]['height']), int(rows[0]['width'])
    lines = {}
    for row in rows:
        if not row['text'].strip() or float(row['conf']) < 0:
            continue
        left, top, right, bottom = int(row['left']), int(row['top']), int(row['left']) + int(row['width']), int(row['top']) + int(row['height'])
        if top < height * .075 or bottom > height * .94 or left < width * .065 or right > width * .96:
            continue
        key = (row['block_num'], row['par_num'], row['line_num'])
        lines.setdefault(key, []).append(row['text'])
    text = '\n'.join(' '.join(words) for words in lines.values())
    text = re.sub(r'(?<=\w)-\n(?=[a-ząćęłńóśźż])', '', text)
    page['text'] = text.strip()
    page['exclude'] = (len(page['text']) < 30
                       or (source_labels is not None and not re.fullmatch(r'\d+|[ivxlcdmIVXLCDM]+', source_labels[page['pdfPage'] - 1])))
    page['needsReview'] = page['needsReview'] or page['exclude']
writer = PdfWriter()
for number, page in enumerate(original.pages, 1):
    overlay = PdfReader(parts / f'{number:04d}.pdf').pages[0]
    scale = Transformation().scale(float(page.mediabox.width) / float(overlay.mediabox.width), float(page.mediabox.height) / float(overlay.mediabox.height))
    page.merge_transformed_page(overlay, scale, over=True)
    writer.add_page(page)
    if source_labels:
        writer.set_page_label(number - 1, number - 1, prefix=source_labels[number - 1])
target = out / 'podrecznik-ocr.pdf'
with target.open('wb') as handle:
    writer.write(handle)
os.chmod(target, 0o600)
prepared = {'format': 'onejournal-kompendium-import', 'version': 1, 'title': args.title,
            'pdfSha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'sourceSha256': source_hash,
            'pageCount': len(pages), 'pages': pages}
(out / 'review.json').write_text(json.dumps(prepared, ensure_ascii=False, indent=2))
print(f'Completed {len(pages)} pages. Review OCR and printed page labels before importing. Input PDF unchanged.', flush=True)
