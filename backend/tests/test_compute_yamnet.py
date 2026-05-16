"""Unit tests for compute_yamnet_is_bark (no TFLite required)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from classify_bark import compute_yamnet_is_bark


class TestComputeYamnetIsBark(unittest.TestCase):
    def test_bark_score_above_threshold_not_relaxed(self):
        labels = [{"class": "Speech", "score": 0.9}]
        ok, relaxed = compute_yamnet_is_bark(labels, 0.35, 0.25)
        self.assertTrue(ok)
        self.assertFalse(relaxed)

    def test_below_threshold_no_labels(self):
        ok, relaxed = compute_yamnet_is_bark([], 0.1, 0.25)
        self.assertFalse(ok)
        self.assertFalse(relaxed)

    def test_dog_relaxed_rule(self):
        labels = [{"class": "Dog", "score": 0.9}]
        ok, relaxed = compute_yamnet_is_bark(labels, 0.11, 0.25)
        self.assertTrue(ok)
        self.assertTrue(relaxed)

    def test_ambiguous_top_class_relaxed_rule(self):
        labels = [{"class": "Animal", "score": 0.3}]
        ok, relaxed = compute_yamnet_is_bark(labels, 0.16, 0.25)
        self.assertTrue(ok)
        self.assertTrue(relaxed)


if __name__ == "__main__":
    unittest.main()
