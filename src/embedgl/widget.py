from __future__ import annotations

import io
import json
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import anywidget
import numpy as np
import polars as pl
import traitlets
from PIL import Image

from .query import evaluate, field_kind, scalar


class EmbeddingViewer(anywidget.AnyWidget):
    """Explore projected rows without transferring the source DataFrame to the browser."""

    _esm = Path(__file__).parent / "static" / "widget.js"
    _css = Path(__file__).parent / "static" / "widget.css"
    dataset = traitlets.Dict().tag(sync=True)
    query = traitlets.Dict().tag(sync=True)
    selected_count = traitlets.Int(0).tag(sync=True)
    selection_revision = traitlets.Int(0).tag(sync=True)
    height = traitlets.Int(640, min=320, max=2000).tag(sync=True)

    def __init__(
        self,
        frame: pl.DataFrame,
        *,
        id_column: str,
        coordinates_2d: Sequence[str] | None = None,
        coordinates_3d: Sequence[str] | None = None,
        cluster_column: str | None = None,
        thumbnail_column: str | None = "thumbnail",
        image_column: str | None = None,
        searchable_columns: Sequence[str] = (),
        filterable_columns: Sequence[str] = (),
        metadata_columns: Sequence[str] = (),
        height: int = 640,
    ) -> None:
        self.id_column = id_column
        self.coordinate_columns = {
            mode: tuple(columns)
            for mode, columns in (("2d", coordinates_2d), ("3d", coordinates_3d))
            if columns is not None
        }
        self.cluster_column = cluster_column
        self.thumbnail_column = thumbnail_column
        self.image_column = image_column
        self.searchable_columns = list(searchable_columns)
        self.filterable_columns = list(filterable_columns)
        self.metadata_columns = list(dict.fromkeys([*metadata_columns, id_column]))
        self._selected = np.empty(0, dtype="<u4")
        self._query_revision = 0
        self._text = ""
        self._filters: list[dict[str, Any]] = []
        self._geometry: dict[str, np.ndarray] = {}
        self._row_column = f"__viewer_{uuid.uuid4().hex}"
        super().__init__(height=height)
        self.replace_data(frame)
        self.on_msg(self._message)

    @property
    def selected_ids(self) -> list[str | int]:
        return self._frame[self._selected.tolist(), :].get_column(self.id_column).to_list()

    @property
    def selected_df(self) -> pl.DataFrame:
        return self._frame[self._selected.tolist(), :]

    def replace_data(self, frame: pl.DataFrame) -> None:
        if not isinstance(frame, pl.DataFrame):
            raise TypeError("frame must be an eager Polars DataFrame")
        if frame.height >= 2**32:
            raise ValueError("Row count must fit uint32")
        if not self.coordinate_columns:
            raise ValueError("Provide coordinates_2d and/or coordinates_3d")
        required = {
            self.id_column,
            *self.searchable_columns,
            *self.filterable_columns,
            *self.metadata_columns,
        }
        required.update(column for columns in self.coordinate_columns.values() for column in columns)
        required.update(column for column in (self.cluster_column, self.image_column) if column)
        if self.thumbnail_column and self.thumbnail_column in frame.columns:
            required.add(self.thumbnail_column)
        missing = required.difference(frame.columns)
        if missing:
            raise ValueError(f"Missing columns: {sorted(missing)}")
        ids = frame.get_column(self.id_column)
        if not (ids.dtype == pl.String or ids.dtype.is_integer()) or ids.null_count() or ids.n_unique() != frame.height:
            raise ValueError("IDs must be unique non-null strings or integers")
        geometry: dict[str, np.ndarray] = {}
        bounds: dict[str, Any] = {}
        for mode, columns in self.coordinate_columns.items():
            if len(columns) != (2 if mode == "2d" else 3):
                raise ValueError(f"{mode} requires {'two' if mode == '2d' else 'three'} coordinate columns")
            if any(not frame.schema[column].is_numeric() for column in columns):
                raise ValueError("Coordinates must be numeric")
            positions = frame.select(columns).to_numpy().astype("<f4")
            if not np.isfinite(positions).all():
                raise ValueError("Coordinates must be finite and non-null")
            if mode == "2d":
                positions = np.column_stack((positions, np.zeros(frame.height, dtype="<f4")))
            geometry[mode] = np.ascontiguousarray(positions, dtype="<f4")
            bounds[mode] = {
                "min": positions.min(axis=0).tolist() if frame.height else [0, 0, 0],
                "max": positions.max(axis=0).tolist() if frame.height else [0, 0, 0],
            }
        fields = [{"name": column, "kind": field_kind(frame.schema[column])} for column in self.filterable_columns]
        for column in self.searchable_columns:
            if field_kind(frame.schema[column]) != "string":
                raise ValueError(f"Search column must be a string: {column}")
        for column in (self.thumbnail_column, self.image_column):
            if column and column in frame.columns and frame.schema[column] != pl.Binary:
                raise ValueError(f"Image column must have Binary dtype: {column}")
        for column in self.metadata_columns:
            if frame.schema[column] == pl.Binary or frame.schema[column].is_nested():
                raise ValueError(f"Metadata must be scalar: {column}")
        legend: list[dict[str, Any]] = []
        unique: list[str] = []
        if self.cluster_column:
            field_kind(frame.schema[self.cluster_column])
            labels = frame.get_column(self.cluster_column).cast(pl.String).fill_null("(null)")
            codes, unique = labels.to_numpy(), labels.unique(maintain_order=True).to_list()
            mapping = {label: index for index, label in enumerate(unique)}
            cluster_codes = np.fromiter((mapping[label] for label in codes), dtype="<u4", count=frame.height)
            legend = [{"code": index, "label": label} for index, label in enumerate(unique[:200])]
        else:
            cluster_codes = np.zeros(frame.height, dtype="<u4")
        self._frame = frame.clone()
        self._indexed = self._frame.with_row_index(self._row_column)
        self._geometry = geometry
        self._clusters = cluster_codes
        self._matches = np.arange(frame.height, dtype="<u4")
        self._selected = np.empty(0, dtype="<u4")
        self._query_revision += 1
        self._text, self._filters = "", []
        with self.hold_sync():
            self.selected_count = 0
            self.selection_revision += 1
            self.query = {"text": "", "filters": [], "revision": self._query_revision, "count": frame.height}
            self.dataset = {
                "revision": uuid.uuid4().hex,
                "count": frame.height,
                "modes": list(geometry),
                "bounds": bounds,
                "fields": fields,
                "searchable": self.searchable_columns,
                "metadata": self.metadata_columns,
                "clusters": legend,
                "cluster_count": len(unique) if self.cluster_column else 0,
                "has_images": bool(self.thumbnail_column and self.thumbnail_column in frame.columns),
            }

    def set_search(self, text: str) -> None:
        self._set_query(text, self._filters)

    def set_filters(self, filters: Sequence[dict[str, Any]]) -> None:
        self._set_query(self._text, list(filters))

    def _set_query(self, text: str, filters: list[dict[str, Any]]) -> None:
        if not isinstance(text, str) or not isinstance(filters, list):
            raise ValueError("Query requires string text and a filter list")
        encoded = json.dumps(filters, allow_nan=False)
        if len(encoded) > 65536:
            raise ValueError("Filters exceed the 64 KiB limit")
        filters = json.loads(encoded)
        indices = (
            evaluate(
                self._indexed,
                self._row_column,
                text,
                filters,
                self.searchable_columns,
                self.filterable_columns,
            )
            .to_numpy()
            .astype("<u4", copy=False)
        )
        if text == self.query.get("text") and filters == self.query.get("filters"):
            return
        self._matches = indices
        self._selected = np.empty(0, dtype="<u4")
        self._query_revision += 1
        self._text, self._filters = text, filters
        with self.hold_sync():
            self.selected_count = 0
            self.selection_revision += 1
            self.query = {"text": text, "filters": filters, "revision": self._query_revision, "count": len(indices)}

    def set_selection(self, ids: Sequence[str | int], mode: str = "replace") -> None:
        values = list(ids)
        rows = self._indexed.filter(pl.col(self.id_column).is_in(values)).get_column(self._row_column).to_numpy()
        if len(rows) != len(set(values)):
            raise ValueError("Selection contains unknown IDs")
        self._select(rows, mode)

    def clear_selection(self) -> None:
        self._select(np.empty(0, dtype="<u4"), "replace")

    def _select(self, rows: np.ndarray, mode: str) -> None:
        if mode not in {"replace", "add", "remove"}:
            raise ValueError("Selection mode must be replace, add or remove")
        if len(rows) and (rows.min() < 0 or rows.max() >= self._frame.height):
            raise ValueError("Selection row out of bounds")
        if mode == "add":
            selected = np.union1d(self._selected, rows)
        elif mode == "remove":
            selected = np.setdiff1d(self._selected, rows)
        else:
            selected = np.unique(rows)
        self._selected = np.asarray(selected, dtype="<u4")
        with self.hold_sync():
            self.selected_count = len(self._selected)
            self.selection_revision += 1

    def _reply(self, request: dict[str, Any], payload: dict[str, Any], buffers: list[bytes] | None = None) -> None:
        self.send(
            {
                "version": 1,
                "request_id": request.get("request_id"),
                "dataset_revision": self.dataset["revision"],
                "query_revision": self.query["revision"],
                **payload,
            },
            buffers=buffers or [],
        )

    def _message(self, widget: anywidget.AnyWidget, content: dict[str, Any], buffers: list[memoryview]) -> None:
        del widget
        if not isinstance(content, dict):
            return
        try:
            if content.get("version") != 1:
                raise ValueError("Unsupported protocol version")
            if content.get("dataset_revision") != self.dataset["revision"]:
                raise ValueError("Dataset changed; reload this view")
            operation = content.get("op")
            if (
                operation in {"select", "select_all", "query", "page", "matches", "facets"}
                and content.get("query_revision") != self.query["revision"]
            ):
                raise ValueError("Query changed; retry with the current query")
            if operation == "geometry":
                mode = str(content.get("mode"))
                positions = self._geometry[mode]
                start = max(0, int(content.get("start", 0)))
                end = min(start + 65536, self._frame.height)
                if start > self._frame.height:
                    raise ValueError("Invalid geometry offset")
                self._reply(
                    content,
                    {"op": "geometry", "mode": mode, "start": start, "end": end},
                    [
                        positions[start:end].tobytes(),
                        self._clusters[start:end].tobytes(),
                    ],
                )
            elif operation in {"matches", "selection"}:
                indices = self._matches if operation == "matches" else self._selected
                start = max(0, int(content.get("start", 0)))
                end = min(start + 262144, len(indices))
                self._reply(
                    content,
                    {
                        "op": operation,
                        "start": start,
                        "end": end,
                        "total": len(indices),
                        "selection_revision": self.selection_revision,
                    },
                    [indices[start:end].tobytes()],
                )
            elif operation == "query":
                self._set_query(content.get("text", ""), content.get("filters", []))
                self._reply(content, {"op": "query", "query": self.query})
            elif operation == "page":
                scope = content.get("scope", "all")
                if scope not in {"all", "selected"}:
                    raise ValueError("Page scope must be all or selected")
                if scope == "selected" and content.get("selection_revision") != self.selection_revision:
                    raise ValueError("Selection changed; retry with the current selection")
                offset = max(0, int(content.get("offset", 0)))
                limit = min(100, max(1, int(content.get("limit", 30))))
                indices = self._selected if scope == "selected" else self._matches
                offset = min(offset, max(0, (len(indices) - 1) // limit * limit))
                rows = indices[offset : offset + limit]
                records = self._frame[rows.tolist(), :].select(self.metadata_columns).to_dicts()
                self._reply(
                    content,
                    {
                        "op": "page",
                        "offset": offset,
                        "scope": scope,
                        "selection_revision": self.selection_revision,
                        "rows": [
                            {
                                "index": int(index),
                                "values": {
                                    key: scalar(value[:2000] if isinstance(value, str) else value)
                                    for key, value in record.items()
                                },
                            }
                            for index, record in zip(rows, records, strict=True)
                        ],
                    },
                )
            elif operation == "detail":
                index = int(content["index"])
                if index < 0 or index >= self._frame.height:
                    raise ValueError("Detail index out of bounds")
                record = self._frame.select(self.metadata_columns).row(index, named=True)
                self._reply(
                    content,
                    {
                        "op": "detail",
                        "index": index,
                        "values": {
                            key: scalar(value[:100000] if isinstance(value, str) else value)
                            for key, value in record.items()
                        },
                    },
                )
            elif operation == "facets":
                column = content.get("column")
                if column not in self.filterable_columns:
                    raise ValueError("Column is not filterable")
                offset = max(0, int(content.get("offset", 0)))
                values = self._frame.get_column(column).drop_nulls().unique().sort()
                self._reply(
                    content,
                    {
                        "op": "facets",
                        "column": column,
                        "total": len(values),
                        "values": [
                            scalar(value[:2000] if isinstance(value, str) else value)
                            for value in values.slice(offset, 100)
                        ],
                    },
                )
            elif operation == "select_all":
                self._select(self._matches, "replace")
                self._reply(content, {"op": "selected"})
            elif operation == "select":
                if len(buffers) != 1 or len(buffers[0]) > self._frame.height * 4 or len(buffers[0]) % 4:
                    raise ValueError("Expected a bounded uint32 selection buffer")
                self._select(np.frombuffer(buffers[0], dtype="<u4"), content.get("mode", "replace"))
                self._reply(content, {"op": "selected"})
            elif operation == "image":
                index = int(content["index"])
                if index < 0 or index >= self._frame.height:
                    raise ValueError("Image index out of bounds")
                column = self.image_column if content.get("full") and self.image_column else self.thumbnail_column
                if not column or column not in self._frame.columns:
                    self._reply(content, {"op": "image", "index": index, "mime": None})
                    return
                image_bytes = self._frame.get_column(column)[index]
                if not image_bytes:
                    self._reply(content, {"op": "image", "index": index, "mime": None})
                    return
                if len(image_bytes) > 20 * 1024 * 1024:
                    raise ValueError("Image exceeds 20 MiB limit")
                with Image.open(io.BytesIO(image_bytes)) as image:
                    mime = Image.MIME.get(image.format or "")
                if mime not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
                    raise ValueError("Unsupported image format")
                self._reply(content, {"op": "image", "index": index, "mime": mime}, [image_bytes])
            else:
                raise ValueError(f"Unknown operation: {operation}")
        except Exception as error:
            self._reply(content, {"op": "error", "error": str(error)})
