import math
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

import polars as pl


def scalar(value: object) -> str | int | float | bool | None:
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, (Decimal, int)) and not isinstance(value, bool):
        return str(value) if isinstance(value, Decimal) or abs(value) > 2**53 - 1 else value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if value is None or isinstance(value, (str, bool)):
        return value
    return str(value)


def field_kind(dtype: pl.DataType) -> str:
    if dtype.is_numeric():
        return "number"
    if dtype == pl.Boolean:
        return "boolean"
    if dtype == pl.Date or isinstance(dtype, pl.Datetime):
        return "date"
    if dtype == pl.String or dtype == pl.Categorical or isinstance(dtype, pl.Enum):
        return "string"
    raise ValueError(f"Unsupported filter dtype: {dtype}. Flatten nested fields before using them as filters.")


def typed_value(value: object, dtype: pl.DataType) -> str | int | float | bool | date | datetime:
    if value is None:
        raise ValueError("Use is_null or not_null to filter null values")
    if dtype == pl.Date:
        return date.fromisoformat(str(value))
    if isinstance(dtype, pl.Datetime):
        parsed = datetime.fromisoformat(str(value))
        if bool(parsed.tzinfo) != bool(dtype.time_zone):
            raise ValueError("Datetime filter timezone must match the column timezone")
        return parsed
    if dtype == pl.Boolean and not isinstance(value, bool):
        raise ValueError("Boolean filters require true or false")
    if dtype.is_numeric():
        return pl.Series([value]).cast(dtype, strict=True).item()
    if isinstance(value, (str, int, float, bool, date, datetime)):
        return value
    raise ValueError("Filter values must be scalar")


def evaluate(
    frame: pl.DataFrame,
    index_column: str,
    text: str,
    filters: list[dict[str, Any]],
    searchable: list[str],
    filterable: list[str],
) -> pl.Series:
    if len(text) > 4096 or len(filters) > 32:
        raise ValueError("Search is limited to 4096 characters and 32 filters")
    predicates: list[pl.Expr] = []
    if text:
        if not searchable:
            raise ValueError("No searchable columns are configured")
        predicates.append(
            pl.any_horizontal(
                [
                    pl.col(column)
                    .cast(pl.String)
                    .str.to_lowercase()
                    .str.contains(text.lower(), literal=True)
                    .fill_null(False)
                    for column in searchable
                ]
            )
        )
    for spec in filters:
        column, operation = spec.get("column"), spec.get("op")
        if column not in filterable:
            raise ValueError(f"Column is not filterable: {column}")
        dtype = frame.schema[column]
        expression = pl.col(column)
        kind = field_kind(dtype)
        if operation == "is_null":
            predicate = expression.is_null()
        elif operation == "not_null":
            predicate = expression.is_not_null()
        elif operation == "contains" and kind == "string":
            predicate = (
                expression.cast(pl.String)
                .str.to_lowercase()
                .str.contains(
                    str(spec.get("value", "")).lower(),
                    literal=True,
                )
            )
        elif operation == "in":
            values = spec.get("value")
            if not isinstance(values, list) or len(values) > 1000:
                raise ValueError("Membership filters require at most 1000 values")
            predicate = expression.is_in([typed_value(value, dtype) for value in values])
        elif operation in {"eq", "gte", "lte"}:
            value = pl.lit(typed_value(spec.get("value"), dtype))
            if operation == "eq":
                predicate = expression == value
            elif operation == "gte" and kind in {"number", "date"}:
                predicate = expression >= value
            elif operation == "lte" and kind in {"number", "date"}:
                predicate = expression <= value
            else:
                raise ValueError(f"Unsupported operation for {column}: {operation}")
        else:
            raise ValueError(f"Unsupported operation for {column}: {operation}")
        predicates.append(predicate.fill_null(False))
    return frame.filter(pl.all_horizontal(predicates) if predicates else pl.lit(True)).get_column(index_column)
