"""Regression for Tesseract TSV words containing literal quote marks."""

import ast
import csv
from pathlib import Path
import tempfile
import unittest


class TesseractTsvTest(unittest.TestCase):
    def test_unmatched_quote_does_not_absorb_following_rows(self):
        source = Path(__file__).resolve().parents[1] / 'scripts' / 'kompendium-ocr.py'
        module = ast.parse(source.read_text())
        function = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == 'read_tsv_rows')
        namespace = {'csv': csv}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)

        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / 'page.tsv'
            fixture.write_text('level\tconf\ttext\n5\t90\t"\n5\t95\tNastępna\n')
            rows = namespace['read_tsv_rows'](fixture)

        self.assertEqual([row['text'] for row in rows], ['"', 'Następna'])
        self.assertEqual(len(rows), 2)


if __name__ == '__main__':
    unittest.main()
