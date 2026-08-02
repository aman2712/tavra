#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "reportlab>=4.2,<5",
# ]
# ///

"""Generate Tavra's one-page demo baggage delay notice.

The layout is airline-inspired but intentionally uses no airline logo or other
brand asset. A prominent demo label prevents the artifact from being mistaken
for an official airline document.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas


CREAM = HexColor("#F7F2E8")
PAPER = HexColor("#FFFCF7")
INK = HexColor("#241C1A")
MUTED = HexColor("#746966")
LINE = HexColor("#E5D9CF")
AIRLINE_RED = HexColor("#C8102E")
DEEP_RED = HexColor("#8C1328")
GOLD = HexColor("#B98A4B")
SOFT_RED = HexColor("#F8E5E6")
WHITE = HexColor("#FFFFFF")


def rounded_label(
    canvas: Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
    fill,
    text_color,
    font_size: float = 8.5,
) -> None:
    canvas.setFillColor(fill)
    canvas.roundRect(x, y, width, height, height / 2, stroke=0, fill=1)
    canvas.setFillColor(text_color)
    canvas.setFont("Helvetica-Bold", font_size)
    canvas.drawCentredString(x + width / 2, y + (height - font_size) / 2 + 1.7, text)


def fit_text(canvas: Canvas, text: str, font: str, max_size: float, max_width: float) -> float:
    size = max_size
    while size > 7 and stringWidth(text, font, size) > max_width:
        size -= 0.25
    return size


def detail_cell(
    canvas: Canvas,
    x: float,
    y: float,
    width: float,
    label: str,
    value: str,
    value_color=INK,
) -> None:
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(x, y + 27, label.upper())
    font_size = fit_text(canvas, value, "Helvetica-Bold", 15, width)
    canvas.setFillColor(value_color)
    canvas.setFont("Helvetica-Bold", font_size)
    canvas.drawString(x, y + 8, value)


def draw_barcode(canvas: Canvas, x: float, y: float, width: float, height: float) -> None:
    # Decorative deterministic stripes, not a machine-readable airline barcode.
    pattern = (1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 2, 1, 3, 1, 1, 2, 3, 2, 1)
    unit = width / (sum(pattern) + len(pattern) - 1)
    cursor = x
    canvas.setFillColor(INK)
    for index, thickness in enumerate(pattern):
        bar_width = thickness * unit
        bar_height = height - (4 if index % 4 == 0 else 0)
        canvas.rect(cursor, y, bar_width, bar_height, stroke=0, fill=1)
        cursor += bar_width + unit


def generate_notice(output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = A4
    canvas = Canvas(str(output_path), pagesize=A4)
    canvas.setTitle("Tavra Demo Baggage Delay Notice")
    canvas.setAuthor("Tavra")
    canvas.setSubject("Demo baggage delay notice for image-intake testing")

    canvas.setFillColor(CREAM)
    canvas.rect(0, 0, width, height, stroke=0, fill=1)

    # Airline-inspired header with an abstract flight path. No airline logo is used.
    canvas.setFillColor(DEEP_RED)
    canvas.rect(0, height - 204, width, 204, stroke=0, fill=1)
    canvas.setFillColor(AIRLINE_RED)
    canvas.setFillAlpha(0.88)
    header_path = canvas.beginPath()
    header_path.moveTo(width * 0.60, height)
    header_path.lineTo(width, height)
    header_path.lineTo(width, height - 204)
    header_path.lineTo(width * 0.82, height - 204)
    header_path.close()
    canvas.drawPath(header_path, stroke=0, fill=1)
    canvas.setFillAlpha(1)

    margin = 42
    rounded_label(
        canvas,
        margin,
        height - 54,
        202,
        23,
        "DEMO DOCUMENT - NOT AIRLINE ISSUED",
        WHITE,
        DEEP_RED,
        7.4,
    )

    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica-Bold", 12)
    canvas.drawRightString(width - margin, height - 46, "EMIRATES")
    canvas.setFillColor(HexColor("#F1C9CE"))
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(width - margin, height - 60, "BAGGAGE SERVICES - SAMPLE")

    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica-Bold", 28)
    canvas.drawString(margin, height - 109, "BAGGAGE DELAY")
    canvas.drawString(margin, height - 141, "NOTICE")
    canvas.setFillColor(HexColor("#F4D7DB"))
    canvas.setFont("Helvetica", 10)
    canvas.drawString(margin, height - 166, "Passenger recovery and claim evidence copy")

    rounded_label(
        canvas,
        width - margin - 114,
        height - 173,
        114,
        31,
        "STATUS: DELAYED",
        WHITE,
        AIRLINE_RED,
        9,
    )

    # Main evidence panel.
    panel_x = margin
    panel_y = 198
    panel_w = width - 2 * margin
    panel_h = 423
    canvas.setFillColor(PAPER)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.8)
    canvas.roundRect(panel_x, panel_y, panel_w, panel_h, 15, stroke=1, fill=1)

    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(panel_x + 24, panel_y + panel_h - 32, "PASSENGER")
    canvas.setFillColor(INK)
    canvas.setFont("Helvetica-Bold", 23)
    canvas.drawString(panel_x + 24, panel_y + panel_h - 59, "Demo Traveler")
    rounded_label(
        canvas,
        panel_x + panel_w - 135,
        panel_y + panel_h - 63,
        111,
        26,
        "1 CHECKED BAG",
        SOFT_RED,
        DEEP_RED,
        8,
    )

    divider_y = panel_y + panel_h - 83
    canvas.setStrokeColor(LINE)
    canvas.line(panel_x + 24, divider_y, panel_x + panel_w - 24, divider_y)

    left = panel_x + 24
    right = panel_x + panel_w / 2 + 9
    col_w = panel_w / 2 - 48
    row_1 = divider_y - 61
    row_2 = row_1 - 66
    row_3 = row_2 - 66

    detail_cell(canvas, left, row_1, col_w, "Airline", "Emirates")
    detail_cell(canvas, right, row_1, col_w, "Flight", "EK202")
    detail_cell(canvas, left, row_2, col_w, "Arrival airport", "AUH")
    detail_cell(canvas, right, row_2, col_w, "Incident date", "August 2, 2026")
    detail_cell(canvas, left, row_3, col_w, "Baggage file reference", "RF392942", DEEP_RED)
    detail_cell(canvas, right, row_3, col_w, "Bag status", "Delayed", AIRLINE_RED)

    evidence_y = panel_y + 50
    evidence_h = 87
    canvas.setFillColor(HexColor("#F2EBE4"))
    canvas.roundRect(panel_x + 20, evidence_y, panel_w - 40, evidence_h, 10, stroke=0, fill=1)
    canvas.setFillColor(GOLD)
    canvas.rect(panel_x + 20, evidence_y, 4, evidence_h, stroke=0, fill=1)
    canvas.setFillColor(INK)
    canvas.setFont("Helvetica-Bold", 10)
    canvas.drawString(panel_x + 38, evidence_y + 61, "NEXT STEP")
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 9.3)
    canvas.drawString(
        panel_x + 38,
        evidence_y + 41,
        "Keep itemized receipts for reasonable replacement essentials.",
    )
    canvas.drawString(
        panel_x + 38,
        evidence_y + 25,
        "Reference RF392942 when preparing the reimbursement packet.",
    )

    # Trace strip and footer.
    strip_y = 108
    canvas.setFillColor(WHITE)
    canvas.setStrokeColor(LINE)
    canvas.roundRect(margin, strip_y, width - 2 * margin, 66, 11, stroke=1, fill=1)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica-Bold", 7.5)
    canvas.drawString(margin + 17, strip_y + 44, "DEMO NOTICE ID")
    canvas.setFillColor(INK)
    canvas.setFont("Helvetica-Bold", 11)
    canvas.drawString(margin + 17, strip_y + 25, "DEMO-AUH-RF392942")
    draw_barcode(canvas, width - margin - 158, strip_y + 17, 140, 31)

    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7.6)
    canvas.drawString(
        margin,
        76,
        "Created for a Tavra product demonstration. This is not an official Emirates document.",
    )
    canvas.drawString(
        margin,
        63,
        "Do not use this sample for travel, identity, payment, or a real baggage claim.",
    )
    canvas.setFillColor(DEEP_RED)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawRightString(width - margin, 63, "TAVRA DEMO")

    canvas.showPage()
    canvas.save()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("output/pdf/tavra-demo-baggage-delay-notice.pdf"),
        help="Output PDF path",
    )
    args = parser.parse_args()
    generate_notice(args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
