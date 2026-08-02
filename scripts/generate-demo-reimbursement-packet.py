#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "reportlab>=4.2,<5",
# ]
# ///

"""Generate Tavra's two-page baggage reimbursement packet.

The packet uses an airline-inspired red and cream visual system without using
an airline logo or other brand asset. All values are deterministic so the
artifact remains stable for the recorded Tavra recovery flow.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas


CREAM = HexColor("#F7F0E5")
PAPER = HexColor("#FFFCF7")
WHITE = HexColor("#FFFFFF")
INK = HexColor("#211A18")
MUTED = HexColor("#766A66")
LINE = HexColor("#E6D8CE")
RED = HexColor("#C8102E")
DEEP_RED = HexColor("#690F20")
PALE_RED = HexColor("#F8E3E5")
GOLD = HexColor("#B68B4D")
PALE_GOLD = HexColor("#F3E9D8")
GREEN = HexColor("#267A5A")
PALE_GREEN = HexColor("#E4F2EB")
SOFT_INK = HexColor("#4E4340")

PAGE_W, PAGE_H = A4
MARGIN = 42
CONTENT_W = PAGE_W - (2 * MARGIN)


def set_fill(canvas: Canvas, color: Color) -> None:
    canvas.setFillColor(color)


def rounded_label(
    canvas: Canvas,
    x: float,
    y: float,
    width: float,
    height: float,
    text: str,
    fill: Color,
    text_color: Color,
    font_size: float = 8.2,
) -> None:
    set_fill(canvas, fill)
    canvas.roundRect(x, y, width, height, height / 2, stroke=0, fill=1)
    set_fill(canvas, text_color)
    canvas.setFont("Helvetica-Bold", font_size)
    canvas.drawCentredString(x + width / 2, y + (height - font_size) / 2 + 1.6, text)


def wrapped_lines(
    text: str,
    font_name: str,
    font_size: float,
    max_width: float,
) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else f"{current} {word}"
        if stringWidth(candidate, font_name, font_size) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_wrapped(
    canvas: Canvas,
    text: str,
    x: float,
    y: float,
    max_width: float,
    font_name: str = "Helvetica",
    font_size: float = 9,
    leading: float = 13,
    color: Color = SOFT_INK,
) -> float:
    set_fill(canvas, color)
    canvas.setFont(font_name, font_size)
    cursor = y
    for line in wrapped_lines(text, font_name, font_size, max_width):
        canvas.drawString(x, cursor, line)
        cursor -= leading
    return cursor


def draw_background(canvas: Canvas) -> None:
    set_fill(canvas, CREAM)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)


def draw_brand(canvas: Canvas, x: float, y: float, light: bool = False) -> None:
    color = WHITE if light else INK
    set_fill(canvas, color)
    canvas.setFont("Helvetica-Bold", 13)
    canvas.drawString(x, y, "TAVRA")
    canvas.setFillColor(GOLD if light else RED)
    canvas.circle(x + 52, y + 4, 2.6, stroke=0, fill=1)


def draw_footer(canvas: Canvas, page_number: int) -> None:
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.7)
    canvas.line(MARGIN, 48, PAGE_W - MARGIN, 48)
    set_fill(canvas, MUTED)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawString(MARGIN, 31, "Prepared by Tavra | Case RCV-DEMO | August 2, 2026")
    canvas.drawRightString(PAGE_W - MARGIN, 31, f"PAGE {page_number} OF 2")


def draw_check(canvas: Canvas, x: float, y: float, radius: float = 8) -> None:
    set_fill(canvas, PALE_GREEN)
    canvas.circle(x, y, radius, stroke=0, fill=1)
    canvas.setStrokeColor(GREEN)
    canvas.setLineWidth(1.6)
    canvas.line(x - 3.2, y, x - 0.6, y - 2.8)
    canvas.line(x - 0.6, y - 2.8, x + 4, y + 3)


def draw_key_value(
    canvas: Canvas,
    x: float,
    y: float,
    label: str,
    value: str,
    width: float,
    accent: bool = False,
) -> None:
    set_fill(canvas, MUTED)
    canvas.setFont("Helvetica-Bold", 7.5)
    canvas.drawString(x, y + 19, label.upper())
    value_size = 13
    while value_size > 8 and stringWidth(value, "Helvetica-Bold", value_size) > width:
        value_size -= 0.25
    set_fill(canvas, DEEP_RED if accent else INK)
    canvas.setFont("Helvetica-Bold", value_size)
    canvas.drawString(x, y, value)


def draw_section_title(
    canvas: Canvas,
    number: str,
    title: str,
    subtitle: str,
    x: float,
    y: float,
) -> None:
    set_fill(canvas, RED)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(x, y, number)
    set_fill(canvas, INK)
    canvas.setFont("Helvetica-Bold", 16)
    canvas.drawString(x + 24, y - 3, title)
    set_fill(canvas, MUTED)
    canvas.setFont("Helvetica", 8.2)
    canvas.drawRightString(PAGE_W - MARGIN, y - 2, subtitle)


def draw_header_page_one(canvas: Canvas) -> None:
    set_fill(canvas, DEEP_RED)
    canvas.rect(0, PAGE_H - 218, PAGE_W, 218, stroke=0, fill=1)
    set_fill(canvas, RED)
    path = canvas.beginPath()
    path.moveTo(PAGE_W * 0.63, PAGE_H)
    path.lineTo(PAGE_W, PAGE_H)
    path.lineTo(PAGE_W, PAGE_H - 218)
    path.lineTo(PAGE_W * 0.82, PAGE_H - 218)
    path.close()
    canvas.drawPath(path, stroke=0, fill=1)

    draw_brand(canvas, MARGIN, PAGE_H - 43, light=True)
    rounded_label(
        canvas,
        PAGE_W - MARGIN - 126,
        PAGE_H - 55,
        126,
        25,
        "READY FOR REVIEW",
        WHITE,
        DEEP_RED,
        8,
    )

    set_fill(canvas, WHITE)
    canvas.setFont("Helvetica-Bold", 29)
    canvas.drawString(MARGIN, PAGE_H - 105, "REIMBURSEMENT")
    canvas.drawString(MARGIN, PAGE_H - 138, "PACKET")
    set_fill(canvas, HexColor("#F2CED4"))
    canvas.setFont("Helvetica", 10)
    canvas.drawString(MARGIN, PAGE_H - 163, "Delayed baggage essentials | Airline claim handoff")

    set_fill(canvas, WHITE)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 99, "AIRLINE")
    canvas.setFont("Helvetica-Bold", 16)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 119, "EMIRATES")
    canvas.setFillColor(HexColor("#F2CED4"))
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 136, "BAGGAGE SERVICES")

    set_fill(canvas, PALE_GOLD)
    canvas.roundRect(MARGIN, PAGE_H - 201, CONTENT_W, 30, 8, stroke=0, fill=1)
    set_fill(canvas, DEEP_RED)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(MARGIN + 13, PAGE_H - 190, "CASE RCV-DEMO")
    set_fill(canvas, SOFT_INK)
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(PAGE_W - MARGIN - 13, PAGE_H - 190, "Prepared August 2, 2026 | USD")


def draw_claim_snapshot(canvas: Canvas) -> None:
    y = 584
    draw_section_title(canvas, "01", "Claim snapshot", "Passenger and disruption record", MARGIN, y)

    panel_y = 432
    panel_h = 125
    set_fill(canvas, PAPER)
    canvas.setStrokeColor(LINE)
    canvas.roundRect(MARGIN, panel_y, CONTENT_W, panel_h, 14, stroke=1, fill=1)

    inner_x = MARGIN + 20
    inner_w = CONTENT_W - 40
    col_w = inner_w / 3
    draw_key_value(canvas, inner_x, panel_y + 75, "Passenger", "Demo Traveler", col_w - 14)
    draw_key_value(canvas, inner_x + col_w, panel_y + 75, "Flight", "EK202", col_w - 14)
    draw_key_value(canvas, inner_x + (2 * col_w), panel_y + 75, "Arrival", "AUH", col_w - 14)
    draw_key_value(canvas, inner_x, panel_y + 27, "Airline", "Emirates", col_w - 14)
    draw_key_value(
        canvas,
        inner_x + col_w,
        panel_y + 27,
        "Baggage reference",
        "RF392942",
        col_w - 14,
        accent=True,
    )
    draw_key_value(
        canvas,
        inner_x + (2 * col_w),
        panel_y + 27,
        "Incident date",
        "Aug 2, 2026",
        col_w - 14,
    )


def draw_expense_summary(canvas: Canvas) -> None:
    title_y = 402
    draw_section_title(canvas, "02", "Expense summary", "Approved recovery essentials", MARGIN, title_y)

    table_top = 372
    table_bottom = 214
    set_fill(canvas, PAPER)
    canvas.setStrokeColor(LINE)
    canvas.roundRect(MARGIN, table_bottom, CONTENT_W, table_top - table_bottom, 14, stroke=1, fill=1)

    set_fill(canvas, PALE_RED)
    canvas.roundRect(MARGIN, table_top - 34, CONTENT_W, 34, 14, stroke=0, fill=1)
    canvas.rect(MARGIN, table_top - 34, CONTENT_W, 17, stroke=0, fill=1)
    set_fill(canvas, DEEP_RED)
    canvas.setFont("Helvetica-Bold", 7.5)
    canvas.drawString(MARGIN + 20, table_top - 21, "ITEM")
    canvas.drawString(PAGE_W - MARGIN - 189, table_top - 21, "DETAIL")
    canvas.drawRightString(PAGE_W - MARGIN - 20, table_top - 21, "AMOUNT")

    rows = (
        ("Replacement T-shirt", "Size M", "$54.00"),
        ("Replacement trousers", "Waist 32, inseam 30", "$78.00"),
        ("Essential toiletry kit", "Travel size", "$22.00"),
    )
    row_y = table_top - 61
    for index, (item, detail, amount) in enumerate(rows):
        set_fill(canvas, INK)
        canvas.setFont("Helvetica-Bold", 9.5)
        canvas.drawString(MARGIN + 20, row_y, item)
        set_fill(canvas, MUTED)
        canvas.setFont("Helvetica", 9)
        canvas.drawString(PAGE_W - MARGIN - 189, row_y, detail)
        set_fill(canvas, INK)
        canvas.setFont("Helvetica-Bold", 10)
        canvas.drawRightString(PAGE_W - MARGIN - 20, row_y, amount)
        if index < len(rows) - 1:
            canvas.setStrokeColor(LINE)
            canvas.line(MARGIN + 20, row_y - 15, PAGE_W - MARGIN - 20, row_y - 15)
        row_y -= 37

    set_fill(canvas, DEEP_RED)
    canvas.roundRect(MARGIN, 157, CONTENT_W, 45, 12, stroke=0, fill=1)
    set_fill(canvas, WHITE)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(MARGIN + 18, 174, "CLAIMED TOTAL")
    canvas.setFont("Helvetica-Bold", 19)
    canvas.drawRightString(PAGE_W - MARGIN - 18, 170, "USD 154.00")


def draw_page_one(canvas: Canvas) -> None:
    draw_background(canvas)
    draw_header_page_one(canvas)
    draw_claim_snapshot(canvas)
    draw_expense_summary(canvas)

    set_fill(canvas, PALE_GREEN)
    canvas.roundRect(MARGIN, 75, CONTENT_W, 62, 12, stroke=0, fill=1)
    draw_check(canvas, MARGIN + 22, 106, 9)
    set_fill(canvas, GREEN)
    canvas.setFont("Helvetica-Bold", 9.5)
    canvas.drawString(MARGIN + 42, 111, "APPROVAL EVIDENCE RECORDED")
    draw_wrapped(
        canvas,
        "Employee approved the exact item set, delivery context, and USD 154.00 total before payment.",
        MARGIN + 42,
        94,
        CONTENT_W - 60,
        font_size=8.3,
        leading=11,
        color=SOFT_INK,
    )
    draw_footer(canvas, 1)


def draw_header_page_two(canvas: Canvas) -> None:
    set_fill(canvas, DEEP_RED)
    canvas.rect(0, PAGE_H - 109, PAGE_W, 109, stroke=0, fill=1)
    draw_brand(canvas, MARGIN, PAGE_H - 42, light=True)
    set_fill(canvas, WHITE)
    canvas.setFont("Helvetica-Bold", 21)
    canvas.drawString(MARGIN, PAGE_H - 77, "EVIDENCE AND HANDOFF")
    rounded_label(
        canvas,
        PAGE_W - MARGIN - 109,
        PAGE_H - 55,
        109,
        25,
        "CASE RCV-DEMO",
        WHITE,
        DEEP_RED,
        7.8,
    )


def checklist_row(
    canvas: Canvas,
    x: float,
    y: float,
    title: str,
    detail: str,
    width: float,
) -> None:
    draw_check(canvas, x + 8, y + 10, 7)
    set_fill(canvas, INK)
    canvas.setFont("Helvetica-Bold", 9.2)
    canvas.drawString(x + 25, y + 14, title)
    draw_wrapped(
        canvas,
        detail,
        x + 25,
        y,
        width - 28,
        font_size=7.8,
        leading=10,
        color=MUTED,
    )


def draw_policy_section(canvas: Canvas) -> None:
    title_y = 696
    draw_section_title(canvas, "03", "Policy readiness", "Reasonable delayed baggage essentials", MARGIN, title_y)
    panel_y = 530
    panel_h = 138
    set_fill(canvas, PAPER)
    canvas.setStrokeColor(LINE)
    canvas.roundRect(MARGIN, panel_y, CONTENT_W, panel_h, 14, stroke=1, fill=1)

    half = (CONTENT_W - 44) / 2
    checklist_row(
        canvas,
        MARGIN + 16,
        panel_y + 88,
        "Disruption identified",
        "Delayed checked baggage recorded against RF392942.",
        half,
    )
    checklist_row(
        canvas,
        MARGIN + 16 + half + 12,
        panel_y + 88,
        "Expenses categorized",
        "Clothing and toiletries marked as replacement essentials.",
        half,
    )
    checklist_row(
        canvas,
        MARGIN + 16,
        panel_y + 35,
        "Approval captured",
        "Employee approved the exact USD 154.00 recovery total.",
        half,
    )
    checklist_row(
        canvas,
        MARGIN + 16 + half + 12,
        panel_y + 35,
        "Receipt follow-up",
        "Order evidence and itemized expense record attached to case.",
        half,
    )


def evidence_row(
    canvas: Canvas,
    y: float,
    name: str,
    value: str,
    status: str,
) -> None:
    set_fill(canvas, INK)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(MARGIN + 19, y, name)
    set_fill(canvas, MUTED)
    canvas.setFont("Helvetica", 8.4)
    canvas.drawString(MARGIN + 187, y, value)
    rounded_label(
        canvas,
        PAGE_W - MARGIN - 88,
        y - 7,
        69,
        20,
        status,
        PALE_GREEN,
        GREEN,
        7,
    )


def draw_evidence_register(canvas: Canvas) -> None:
    title_y = 500
    draw_section_title(canvas, "04", "Evidence register", "Traceable claim record", MARGIN, title_y)
    panel_y = 343
    panel_h = 129
    set_fill(canvas, PAPER)
    canvas.setStrokeColor(LINE)
    canvas.roundRect(MARGIN, panel_y, CONTENT_W, panel_h, 14, stroke=1, fill=1)

    rows = (
        ("Baggage disruption", "EK202 | AUH | RF392942", "RECORDED"),
        ("Purchase approval", "Employee approval | USD 154.00", "RECORDED"),
        ("Delivery context", "Masdar City, Abu Dhabi", "RECORDED"),
        ("Expense detail", "3 essentials | itemized above", "ATTACHED"),
    )
    row_y = panel_y + panel_h - 27
    for index, row in enumerate(rows):
        evidence_row(canvas, row_y, *row)
        if index < len(rows) - 1:
            canvas.setStrokeColor(LINE)
            canvas.line(MARGIN + 19, row_y - 14, PAGE_W - MARGIN - 19, row_y - 14)
        row_y -= 29


def draw_notification_section(canvas: Canvas) -> None:
    title_y = 313
    draw_section_title(canvas, "05", "Notification summary", "Employee and company knowledge record", MARGIN, title_y)
    panel_y = 185
    panel_h = 100
    set_fill(canvas, PALE_GOLD)
    canvas.roundRect(MARGIN, panel_y, CONTENT_W, panel_h, 14, stroke=0, fill=1)
    set_fill(canvas, GOLD)
    canvas.rect(MARGIN, panel_y, 5, panel_h, stroke=0, fill=1)

    set_fill(canvas, DEEP_RED)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(MARGIN + 21, panel_y + 73, "EMPLOYEE RECORD")
    draw_wrapped(
        canvas,
        "Demo Traveler | Recovery purchase and reimbursement case linked to the employee travel profile.",
        MARGIN + 21,
        panel_y + 56,
        CONTENT_W / 2 - 35,
        font_size=8,
        leading=10,
        color=SOFT_INK,
    )

    divider_x = MARGIN + CONTENT_W / 2
    canvas.setStrokeColor(HexColor("#DDC9A7"))
    canvas.line(divider_x, panel_y + 18, divider_x, panel_y + panel_h - 18)

    set_fill(canvas, DEEP_RED)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(divider_x + 18, panel_y + 73, "COMPANY RECORD")
    draw_wrapped(
        canvas,
        "Travel and expense context updated with case RCV-DEMO and the USD 154.00 claimed total.",
        divider_x + 18,
        panel_y + 56,
        CONTENT_W / 2 - 36,
        font_size=8,
        leading=10,
        color=SOFT_INK,
    )


def draw_handoff_note(canvas: Canvas) -> None:
    set_fill(canvas, PAPER)
    canvas.setStrokeColor(LINE)
    canvas.roundRect(MARGIN, 76, CONTENT_W, 87, 13, stroke=1, fill=1)
    set_fill(canvas, RED)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(MARGIN + 18, 138, "AIRLINE HANDOFF NOTE")
    draw_wrapped(
        canvas,
        "This packet consolidates the disruption record, replacement essentials, approval evidence, and delivery context for Emirates baggage services. Final eligibility and reimbursement timing remain subject to airline review.",
        MARGIN + 18,
        120,
        CONTENT_W - 36,
        font_size=8.6,
        leading=12,
        color=SOFT_INK,
    )
    set_fill(canvas, MUTED)
    canvas.setFont("Helvetica-Bold", 7.2)
    canvas.drawRightString(PAGE_W - MARGIN - 18, 86, "PREPARED BY TAVRA")


def draw_page_two(canvas: Canvas) -> None:
    draw_background(canvas)
    draw_header_page_two(canvas)
    draw_policy_section(canvas)
    draw_evidence_register(canvas)
    draw_notification_section(canvas)
    draw_handoff_note(canvas)
    draw_footer(canvas, 2)


def generate_packet(output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(output_path), pagesize=A4)
    canvas.setTitle("Tavra Baggage Reimbursement Packet")
    canvas.setAuthor("Tavra")
    canvas.setSubject("Delayed baggage reimbursement packet for case RCV-DEMO")
    canvas.setKeywords("Tavra, reimbursement, delayed baggage, Emirates, RCV-DEMO")

    draw_page_one(canvas)
    canvas.showPage()
    draw_page_two(canvas)
    canvas.showPage()
    canvas.save()


def ensure_ascii_hyphens(texts: Iterable[str]) -> None:
    forbidden = ("\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212")
    for text in texts:
        if any(character in text for character in forbidden):
            raise ValueError("Use ASCII hyphens only")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("output/pdf/tavra-reimbursement-packet.pdf"),
        help="Output PDF path",
    )
    args = parser.parse_args()
    ensure_ascii_hyphens((__doc__ or "", args.output.name))
    generate_packet(args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
