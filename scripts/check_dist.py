import argparse
import tarfile
import zipfile
from email.parser import BytesParser
from pathlib import Path


def check_dist(directory: Path) -> None:
    wheels = sorted(directory.glob("*.whl"))
    sources = sorted(directory.glob("*.tar.gz"))
    if len(wheels) != 1 or len(sources) != 1:
        raise ValueError("Expected exactly one wheel and one sdist; use a clean dist directory.")
    required = (
        "embedgl/__init__.py",
        "embedgl/widget.py",
        "embedgl/query.py",
        "embedgl/demo.py",
        "embedgl/static/widget.js",
        "embedgl/static/widget.css",
        "embedgl/THIRD_PARTY_LICENSES.txt",
    )
    with zipfile.ZipFile(wheels[0]) as wheel, tarfile.open(sources[0]) as source:
        prefix = sources[0].name.removesuffix(".tar.gz")
        for name in required:
            data = wheel.read(name)
            member = source.extractfile(f"{prefix}/src/{name}")
            if not data or member is None or member.read() != data:
                raise ValueError(f"Missing, empty, or mismatched distribution file: {name}")
        for name in ("src/build_support.py", "scripts/licenses.mjs", "package-lock.json", "tests/test_widget.py"):
            source.getmember(f"{prefix}/{name}")
        metadata_name = next(name for name in wheel.namelist() if name.endswith(".dist-info/METADATA"))
        metadata = BytesParser().parsebytes(wheel.read(metadata_name))
        if metadata["Name"] != "embedgl" or "Private :: Do Not Upload" in metadata.get_all("Classifier", []):
            raise ValueError("Distribution name or public-release classifiers are incorrect.")
        if not any(name.endswith(".dist-info/licenses/LICENSE") for name in wheel.namelist()):
            raise ValueError("The project license is missing from the wheel.")
    print(f"Validated {wheels[0].name} and {sources[0].name}: package, assets, notices, and metadata.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Check embedgl release archive contents.")
    parser.add_argument("directory", nargs="?", type=Path, default=Path("dist"))
    check_dist(parser.parse_args().directory)
