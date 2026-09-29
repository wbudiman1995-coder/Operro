"""Build the bundled Indonesian province/city/district selector data.

Input: db/wilayah.sql from https://github.com/cahyadsn/wilayah (MIT).
Run: python apps/web/scripts/extract-indonesia-regions.py path/to/wilayah.sql
"""

import json
import re
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: extract-indonesia-regions.py path/to/wilayah.sql")
    source = Path(sys.argv[1]).read_text(encoding="utf-8")
    rows: dict[str, str] = {}
    for line in source.splitlines():
        match = re.fullmatch(r"\('([0-9.]+)','(.*)'\)[,;]", line.strip())
        if match:
            code, name = match.groups()
            if code.count(".") <= 2:
                rows[code] = name.replace("\\'", "'").replace("''", "'")

    provinces = [{"code": code, "name": name} for code, name in rows.items() if code.count(".") == 0]
    regencies: dict[str, list[dict[str, str]]] = {}
    districts: dict[str, list[dict[str, str]]] = {}
    for code, name in rows.items():
        parts = code.split(".")
        if len(parts) == 2:
            regencies.setdefault(parts[0], []).append({"code": code, "name": name})
        elif len(parts) == 3:
            districts.setdefault(".".join(parts[:2]), []).append({"code": code, "name": name})

    assert len(provinces) >= 38, f"Too few provinces: {len(provinces)}"
    assert sum(map(len, regencies.values())) >= 500, "Too few cities/regencies"
    assert sum(map(len, districts.values())) >= 7000, "Too few districts"
    payload = {"provinces": provinces, "regencies": regencies, "districts": districts}
    target = Path(__file__).resolve().parents[1] / "src" / "data" / "indonesia-regions.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    lite = target.with_name("indonesia-regions-lite.json")
    lite.write_text(json.dumps({"provinces": provinces, "regencies": regencies}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(provinces)} provinces, {sum(map(len, regencies.values()))} regencies, {sum(map(len, districts.values()))} districts -> {target}")


if __name__ == "__main__":
    main()
