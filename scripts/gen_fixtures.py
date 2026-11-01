#!/usr/bin/env python3
"""Generates the 6 SYNTHETIC proof fixtures (every image is stamped SAMPLE / SYNTHETIC). Fictional people and fake receipt numbers only.
The ground-truth extraction is embedded in a PNG tEXt chunk for the offline `fixture` extractor; manifest.json holds the expected recommendations."""
import json, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from PIL.PngImagePlugin import PngInfo

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'proofs')
os.makedirs(OUT, exist_ok=True)
F = lambda n: ImageFont.load_default(size=n)
CTX = {'case_created_at': '2026-01-15', 'beneficiary_name': 'Mateo Reyes', 'expected_form_type': 'I-130'}
TITLES = {'receipt_notice': 'NOTICE OF ACTION - RECEIPT', 'rfe_response': 'RESPONSE TO REQUEST FOR EVIDENCE', 'interview_notice': 'INTERVIEW APPOINTMENT NOTICE'}

def ex(form, receipt, date, name, doc, legibility='clear', conf=0.95):
    return {'form_type': form, 'receipt_number': receipt, 'notice_date': date, 'beneficiary_name': name, 'document_type': doc,
            'case_type': 'Family petition (synthetic)' if form else None, 'legibility': legibility, 'confidence': conf}

FIX = [
  ('good_receipt_notice', 'good: receipt notice', ex('I-130', 'EAC2612345678', '2026-02-10', 'Mateo Reyes', 'receipt_notice'), 'receipt_notice', 'recommend_approve', 1.0),
  ('good_rfe_response', 'good: RFE response (middle name present)', ex('I-130', 'SRC2698765432', '2026-05-03', 'Mateo Jose Reyes', 'rfe_response'), 'rfe_response', 'recommend_approve', 1.0),
  ('good_interview_notice', 'good: interview notice', ex('I-130', 'NBC2611122233', '2026-09-14', 'Mateo Reyes', 'interview_notice'), 'interview_notice', 'recommend_approve', 1.0),
  ('forged_blatant', 'forged: bad receipt format, wrong form, future date, name mismatch', ex('I-765', 'EAC-26-1234', '2027-03-10', 'M. Reyez', 'receipt_notice'), 'receipt_notice', 'recommend_reject', 0.25),
  ('forged_subtle', 'forged: everything valid except the beneficiary name', ex('I-130', 'EAC2611998877', '2026-03-02', 'Marco Reyes', 'receipt_notice'), 'receipt_notice', 'needs_human_review', 0.8),
  ('blurry', 'blurry: unreadable fields, low confidence', ex(None, None, None, None, None, 'blurry', 0.3), 'receipt_notice', 'needs_human_review', 0.5),
]

def draw(e, label):
    im = Image.new('RGB', (800, 1000), (250, 248, 240)); d = ImageDraw.Draw(im)
    d.rectangle([20, 20, 780, 980], outline=(60, 60, 60), width=3)
    d.rectangle([20, 20, 780, 90], fill=(200, 30, 30)); d.text((40, 38), 'SAMPLE / SYNTHETIC - NOT A REAL DOCUMENT', font=F(30), fill='white')
    doc = e['document_type'] or 'receipt_notice'
    d.text((60, 130), TITLES[doc], font=F(34), fill=(20, 20, 20))
    rows = [('Form type', e['form_type'] or 'I-130'), ('Receipt number', e['receipt_number'] or 'EAC2600000000'), ('Notice date', e['notice_date'] or '2026-01-01'),
            ('Beneficiary', e['beneficiary_name'] or 'Mateo Reyes'), ('Case type', 'Family petition (synthetic)')]
    y = 230
    for k, v in rows:
        d.text((60, y), k + ':', font=F(26), fill=(90, 90, 90)); d.text((330, y), v, font=F(30), fill=(10, 10, 10)); y += 80
    d.text((60, 700), 'Petitioner: Ana Reyes (fictional) - sibling of the beneficiary', font=F(22), fill=(90, 90, 90))
    d.text((60, 900), 'Fictional demo data generated for Guardian Pay hackathon. Fake numbers.', font=F(20), fill=(120, 120, 120))
    wm = Image.new('RGBA', (800, 1000), (0, 0, 0, 0)); w = ImageDraw.Draw(wm); w.text((120, 560), 'SYNTHETIC', font=F(130), fill=(200, 30, 30, 45))
    im = Image.alpha_composite(im.convert('RGBA'), wm.rotate(25, resample=Image.BICUBIC)).convert('RGB')
    if e['legibility'] == 'blurry': im = im.filter(ImageFilter.GaussianBlur(14))
    return im

manifest = []
for name, label, e, doc, expected, score in FIX:
    meta = PngInfo(); meta.add_text('gp-fixture-extraction', json.dumps(e)); meta.add_text('gp-synthetic', 'SAMPLE / SYNTHETIC - fictional data')
    draw(e, label).save(os.path.join(OUT, name + '.png'), pnginfo=meta, optimize=True)
    manifest.append({'file': name + '.png', 'label': label, 'expected_recommendation': expected, 'expected_score': score,
                     'context': {**CTX, 'expected_document_type': doc}})
json.dump({'now': '2026-11-01T12:00:00Z', 'fixtures': manifest}, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=2)
print('wrote', len(manifest), 'fixtures to', os.path.abspath(OUT))
