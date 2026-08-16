#!/usr/bin/env python3
"""Fetch Pokémon card thumbnails and attach deterministic 64-bit dHashes."""

from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import pathlib
import time
import urllib.request

from PIL import Image


def dhash(payload: bytes) -> str:
    image = Image.open(io.BytesIO(payload)).convert("RGB")
    image = image.resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(image.convert("L").getdata())
    bits = "".join("1" if pixels[row * 9 + column] > pixels[row * 9 + column + 1] else "0"
                   for row in range(8) for column in range(8))
    return f"{int(bits, 2):016x}"


def fingerprint(card: dict, attempts: int = 4) -> tuple[str, str]:
    identifier = str(card.get("id", ""))
    url = str(card.get("images", {}).get("small", ""))
    if not identifier or not url:
        return identifier, ""
    request = urllib.request.Request(url, headers={"User-Agent": "CollectFolio visual-index generator/1"})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return identifier, dhash(response.read())
        except Exception:
            if attempt + 1 == attempts:
                return identifier, ""
            time.sleep(0.5 * (attempt + 1))
    return identifier, ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=pathlib.Path, help="pokemon-tcg-data cards/en directory")
    parser.add_argument("--workers", type=int, default=24)
    args = parser.parse_args()
    paths = sorted(args.source.glob("*.json"))
    records = [(path, json.loads(path.read_text())) for path in paths]
    cards = [card for _, group in records for card in group if not card.get("visualHash")]
    hashes: dict[str, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 48))) as executor:
        futures = [executor.submit(fingerprint, card) for card in cards]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            identifier, value = future.result()
            if value:
                hashes[identifier] = value
            if index % 500 == 0 or index == len(futures):
                print(f"fingerprinted {index}/{len(futures)} ({len(hashes)} successful)", flush=True)
    for path, group in records:
        changed = False
        for card in group:
            value = hashes.get(str(card.get("id", "")))
            if value:
                card["visualHash"] = value
                changed = True
        if changed:
            path.write_text(json.dumps(group, ensure_ascii=False, separators=(",", ":")) + "\n")
    failures = len(cards) - len(hashes)
    print(f"completed with {len(hashes)} fingerprints and {failures} failures", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
