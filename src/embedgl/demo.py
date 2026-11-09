"""Small projected document dataset for trying the widget without loading receipt models."""

import io
from datetime import date, timedelta

import numpy as np
import polars as pl
from PIL import Image, ImageDraw

from .widget import EmbeddingViewer


def make_demo_frame(count: int = 2000, seed: int = 42) -> pl.DataFrame:
    if count < 1:
        raise ValueError("count must be positive")
    generator = np.random.default_rng(seed)
    merchants = ["Northline Market", "Corner Coffee", "Field Supply", "Paper House"]
    categories = ["Groceries", "Dining", "Supplies", "Stationery"]
    samples: list[bytes] = []
    for template in range(24):
        image = Image.new("RGB", (192, 256), "#fafaf5")
        draw = ImageDraw.Draw(image)
        draw.rectangle((8, 8, 183, 247), outline="#d9ddd5")
        draw.text((20, 23), merchants[template % 4], fill="#253a3a")
        draw.text((20, 45), f"RECEIPT  #{template + 1001}", fill="#57605b")
        draw.line((20, 66, 172, 66), fill="#bbc6bd")
        for line in range(5):
            draw.text(
                (20, 80 + line * 20), f"Item {line + 1}       {(template + line + 2) * 1.25:6.2f}", fill="#3e4640"
            )
        draw.line((20, 187, 172, 187), fill="#bbc6bd")
        draw.text((20, 201), f"TOTAL         {(template + 5) * 6.25:6.2f}", fill="#253a3a")
        draw.text((20, 225), "Thank you", fill="#6b7c73")
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=80)
        samples.append(output.getvalue())
    labels = generator.integers(0, 4, size=count)
    centers = np.array([[-2, -1], [1.5, 1], [-1, 2], [2, -2]])
    coordinates = centers[labels] + generator.normal(0, 0.55, (count, 2))
    templates = generator.integers(0, len(samples), size=count)
    amounts = generator.uniform(3, 250, size=count).round(2)
    return pl.DataFrame(
        {
            "id": [f"demo-{index:06d}" for index in range(count)],
            "file_name": [f"receipt_{index:06d}.jpg" for index in range(count)],
            "merchant": [merchants[label] for label in labels],
            "category": [categories[label] for label in labels],
            "amount": amounts,
            "date": [date(2026, 1, 1) + timedelta(days=int(day)) for day in generator.integers(0, 300, size=count)],
            "reviewed": generator.random(count) > 0.5,
            "ocr_text": [
                f"{merchants[label]} receipt total {amount:.2f}" for label, amount in zip(labels, amounts, strict=True)
            ],
            "thumbnail": [samples[template] for template in templates],
            "x": coordinates[:, 0],
            "y": coordinates[:, 1],
            "z": generator.normal(0, 0.6, count) + labels * 0.6,
        }
    )


def make_demo(count: int = 2000) -> EmbeddingViewer:
    return EmbeddingViewer(
        make_demo_frame(count),
        id_column="id",
        coordinates_2d=("x", "y"),
        coordinates_3d=("x", "y", "z"),
        cluster_column="category",
        searchable_columns=("file_name", "merchant", "ocr_text"),
        filterable_columns=("merchant", "category", "amount", "date", "reviewed"),
        metadata_columns=("file_name", "merchant", "category", "amount", "date", "reviewed", "ocr_text"),
    )
