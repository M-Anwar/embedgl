from pathlib import Path

from setuptools.command.build_py import build_py


class CheckedBuildPy(build_py):
    def run(self) -> None:
        package = Path(__file__).parent / "embedgl"
        for relative in ("static/widget.js", "static/widget.css", "THIRD_PARTY_LICENSES.txt"):
            asset = package / relative
            if not asset.is_file() or not asset.stat().st_size:
                raise RuntimeError(f"Missing release asset: {relative}. Run npm ci and npm run build first.")
        super().run()
