#!/usr/bin/env python3
"""Network-free checks for the semantic retrieval prototype."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from semantic_retrieval import compact_document, cosine, reciprocal_rank_fusion


class SemanticRetrievalTest(unittest.TestCase):
    def test_document_keeps_identity_deduplicates_and_stays_bounded(self):
        document = compact_document({
            "title_en": "Television viewing",
            "concepts": ["Television use: Time spent viewing television"],
            "subject_en": ["Culture", "Culture"],
            "survey_en": ["Viewing survey"],
            "search_dimensions": "Geography | Age | Geography",
            "search_members": "Canada | Television | Television | Radio",
            "search_notes": "A long explanatory note",
        }, 260)
        self.assertTrue(document.startswith("Title: Television viewing"))
        self.assertEqual(document.count("Television;"), 1)
        self.assertLessEqual(len(document), 260)

        identity = compact_document({"title_en": "Television viewing", "search_members": "Radio"},
                                    details=False)
        self.assertIn("Television viewing", identity)
        self.assertNotIn("Radio", identity)

    def test_cosine_and_rrf(self):
        self.assertAlmostEqual(cosine([1, 0], [1, 0]), 1)
        self.assertAlmostEqual(cosine([1, 0], [0, 1]), 0)
        merged = reciprocal_rank_fusion([("a", 9), ("b", 8)], [("b", .9), ("c", .8)])
        self.assertEqual([pid for pid, _ in merged], ["b", "a", "c"])
        weighted = reciprocal_rank_fusion([("a", 9)], [("b", .9)], weights=[1, 2])
        self.assertEqual([pid for pid, _ in weighted], ["b", "a"])
        with self.assertRaises(ValueError):
            reciprocal_rank_fusion([("a", 9)], weights=[1, 2])


if __name__ == "__main__":
    unittest.main()
