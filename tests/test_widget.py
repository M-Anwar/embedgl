import unittest
from importlib.metadata import metadata
from importlib.resources import files
from unittest.mock import patch

import numpy as np
import polars as pl

from embedgl import EmbeddingViewer
from embedgl.demo import make_demo


class WidgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.frame = pl.DataFrame(
            {
                "id": ["a", "b", "c"],
                "x": [0.0, 1.0, 2.0],
                "y": [2.0, 1.0, 0.0],
                "label": ["Coffee", "Tea", "Coffee cake"],
                "amount": [1, 2, 3],
            }
        )
        self.viewer = EmbeddingViewer(
            self.frame,
            id_column="id",
            coordinates_2d=("x", "y"),
            searchable_columns=("label",),
            filterable_columns=("amount",),
        )
        self.addCleanup(self.viewer.close)

    def test_installed_resources(self) -> None:
        package = files("embedgl")
        for name in ("static/widget.js", "static/widget.css", "THIRD_PARTY_LICENSES.txt"):
            self.assertTrue(package.joinpath(name).read_bytes(), name)
        self.assertTrue(self.viewer._esm)
        self.assertTrue(self.viewer._css)
        self.assertEqual(metadata("embedgl")["Name"], "embedgl")

    def test_search_and_filter(self) -> None:
        self.viewer.set_search("COFFEE")
        self.assertEqual(self.viewer.query["count"], 2)
        self.viewer.set_filters([{"column": "amount", "op": "gte", "value": 2}])
        self.assertEqual(self.viewer.query["count"], 1)

    def test_selection_modes(self) -> None:
        self.viewer.set_selection(["b"])
        self.viewer.set_selection(["a"], mode="add")
        self.assertEqual(self.viewer.selected_ids, ["a", "b"])
        self.viewer.set_selection(["a"], mode="remove")
        self.assertEqual(self.viewer.selected_df["id"].to_list(), ["b"])
        self.viewer.clear_selection()
        self.assertEqual(self.viewer.selected_count, 0)

    def test_query_clears_selection(self) -> None:
        self.viewer.set_selection(["a"])
        self.viewer.set_search("tea")
        self.assertEqual(self.viewer.selected_ids, [])

    def test_replacement_resets_state(self) -> None:
        revision = self.viewer.dataset["revision"]
        self.viewer.set_search("tea")
        self.viewer.set_selection(["a"])
        self.viewer.replace_data(self.frame.head(1))
        self.assertNotEqual(self.viewer.dataset["revision"], revision)
        self.assertEqual(self.viewer.query["count"], 1)
        self.assertEqual(self.viewer.selected_ids, [])

    def test_empty_frame(self) -> None:
        self.viewer.replace_data(self.frame.head(0))
        self.assertEqual(self.viewer.dataset["count"], 0)
        self.assertEqual(self.viewer.dataset["bounds"], {"2d": {"min": [0, 0, 0], "max": [0, 0, 0]}})

    def test_invalid_ids(self) -> None:
        with self.assertRaises(ValueError):
            self.viewer.set_selection(["unknown"])
        with self.assertRaises(ValueError):
            self.viewer.replace_data(self.frame.with_columns(pl.lit("duplicate").alias("id")))

    def test_geometry_protocol(self) -> None:
        request = {
            "version": 1,
            "op": "geometry",
            "request_id": "test",
            "mode": "2d",
            "dataset_revision": self.viewer.dataset["revision"],
        }
        with patch.object(self.viewer, "send") as send:
            self.viewer._message(self.viewer, request, [])
        content = send.call_args.args[0]
        self.assertEqual(content["op"], "geometry")
        self.assertEqual(content["end"], 3)
        positions = np.frombuffer(send.call_args.kwargs["buffers"][0], dtype="<f4").reshape(-1, 3)
        np.testing.assert_array_equal(positions[:, :2], self.frame.select("x", "y").to_numpy())
        np.testing.assert_array_equal(positions[:, 2], np.zeros(3))

    def test_demo(self) -> None:
        viewer = make_demo(count=12)
        self.addCleanup(viewer.close)
        self.assertEqual(viewer.dataset["count"], 12)
        self.assertEqual(viewer.dataset["modes"], ["2d", "3d"])
        self.assertTrue(viewer.dataset["has_images"])


if __name__ == "__main__":
    unittest.main()
