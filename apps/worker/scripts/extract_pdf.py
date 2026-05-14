import json
import os
import sys
from pathlib import Path

import fitz


def page_text_ordered(page: fitz.Page) -> str:
    """Join text blocks in reading order (top-to-bottom, left-to-right)."""
    blocks = page.get_text("blocks") or []
    rows: list[tuple[float, float, str]] = []
    for b in blocks:
        if len(b) < 5:
            continue
        x0, y0, _x1, _y1, text = b[0], b[1], b[2], b[3], b[4]
        t = (text or "").strip()
        if not t:
            continue
        rows.append((float(y0), float(x0), t))
    if not rows:
        return (page.get_text("text") or "").strip()
    rows.sort(key=lambda r: (round(r[0], 2), round(r[1], 2)))
    return "\n\n".join(r[2] for r in rows)


def render_page_png(page: fitz.Page, out_path: Path) -> str | None:
    """
    Rasterize page for vision models. Returns basename on success.
    Set QUIZMORPH_PAGE_PNG=0 to skip (text-only extraction).
    """
    if os.environ.get("QUIZMORPH_PAGE_PNG", "1").strip() == "0":
        return None
    max_px = int(os.environ.get("QUIZMORPH_MAX_PAGE_PIXEL", "1400"))
    rw = max(float(page.rect.width), 1e-6)
    rh = max(float(page.rect.height), 1e-6)
    z = min(2.0, max_px / rw, max_px / rh)
    z = max(0.8, z)
    mat = fitz.Matrix(z, z)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    pix.save(str(out_path))
    return out_path.name


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[2] == "meta":
        pdf_path = sys.argv[1]
        doc = fitz.open(pdf_path)
        try:
            print(json.dumps({"totalPages": len(doc)}))
        finally:
            doc.close()
        return

    if len(sys.argv) < 5:
        print(
            "usage: extract_pdf.py <pdf> meta | extract_pdf.py <pdf> <pageStart> <pageEnd> <outDir>",
            file=sys.stderr,
        )
        sys.exit(1)

    pdf_path = sys.argv[1]
    page_start = int(sys.argv[2])
    page_end = int(sys.argv[3])
    out_dir = Path(sys.argv[4])
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = fitz.open(pdf_path)
    try:
        pages_out: list[dict] = []
        for p in range(page_start, page_end + 1):
            if p < 1 or p > len(doc):
                continue
            page = doc[p - 1]
            text = page_text_ordered(page)
            img_name: str | None = None
            png_path = out_dir / f"page_{p:04d}.png"
            try:
                img_name = render_page_png(page, png_path)
            except Exception as e:
                print(f"warn: page {p} raster failed: {e}", file=sys.stderr)
            entry: dict = {"pageNumber": p, "text": text}
            if img_name:
                entry["pageImage"] = img_name
            pages_out.append(entry)

        print(json.dumps({"pages": pages_out, "totalPages": len(doc)}))
    finally:
        doc.close()


if __name__ == "__main__":
    main()
