#!/usr/bin/env python3
"""Bounded PDF/DOCX extraction and PDF page rendering for AgentDock."""

import json
import sys
import zipfile
import xml.etree.ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}


def fail(message: str) -> None:
    sys.stderr.buffer.write(json.dumps({"error": message}, ensure_ascii=False).encode("utf-8"))
    raise SystemExit(2)


def emit_json(value: dict) -> None:
    sys.stdout.buffer.write(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def load_fitz():
    try:
        import fitz
    except ImportError:
        fail("PyMuPDF is not installed. Install it with: python -m pip install pymupdf")
    return fitz


def bounded_utf8(value: str, max_bytes: int) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value, False
    suffix = "\n...[truncated]"
    suffix_bytes = suffix.encode("utf-8")
    budget = max(0, max_bytes - len(suffix_bytes))
    chunk = encoded[:budget]
    while chunk:
        try:
            text = chunk.decode("utf-8")
            return text + suffix, True
        except UnicodeDecodeError as exc:
            chunk = chunk[: exc.start]
    return suffix.lstrip("\n"), True


def pdf_text(args: list[str]) -> None:
    if len(args) != 4:
        fail("Usage: document-worker.py pdf-text <path> <start-page> <end-page-or-0> <max-bytes>")
    file_path, start_raw, end_raw, max_raw = args
    start_page = int(start_raw)
    end_page = int(end_raw)
    max_bytes = max(1000, int(max_raw))
    fitz = load_fitz()

    try:
        document = fitz.open(file_path)
    except Exception as exc:
        fail(f"Unable to open PDF: {exc}")
    try:
        page_count = int(document.page_count)
        if page_count <= 0:
            fail("PDF has no pages.")
        if start_page < 1 or start_page > page_count:
            fail(f"start_page must be between 1 and {page_count}.")
        requested_end = page_count if end_page <= 0 else min(end_page, page_count)
        if requested_end < start_page:
            fail("end_page must be >= start_page.")

        chunks: list[str] = []
        returned_end = start_page - 1
        truncated = False
        for page_number in range(start_page, requested_end + 1):
            page = document.load_page(page_number - 1)
            text = page.get_text("text").strip()
            if not text:
                text = "[No extractable text on this page]"
            chunk = f"--- Page {page_number} ---\n{text}"
            candidate = "\n\n".join([*chunks, chunk])
            if len(candidate.encode("utf-8")) <= max_bytes:
                chunks.append(chunk)
                returned_end = page_number
                continue

            if not chunks:
                bounded, _ = bounded_utf8(chunk, max_bytes)
                chunks.append(bounded)
                returned_end = page_number
            truncated = True
            break

        output = "\n\n".join(chunks)
        next_page = returned_end + 1 if returned_end < requested_end else None
        emit_json({
            "page_count": page_count,
            "start_page": start_page,
            "end_page": returned_end,
            "requested_end_page": requested_end,
            "next_page": next_page,
            "bytes_returned": len(output.encode("utf-8")),
            "truncated": truncated or next_page is not None,
            "text": output,
        })
    finally:
        document.close()


def pdf_render(args: list[str]) -> None:
    if len(args) != 3:
        fail("Usage: document-worker.py pdf-render <path> <page> <max-dimension>")
    file_path, page_raw, dimension_raw = args
    page_number = int(page_raw)
    max_dimension = max(128, min(int(dimension_raw), 2400))
    fitz = load_fitz()

    try:
        document = fitz.open(file_path)
    except Exception as exc:
        fail(f"Unable to open PDF: {exc}")
    try:
        page_count = int(document.page_count)
        if page_number < 1 or page_number > page_count:
            fail(f"page must be between 1 and {page_count}.")
        page = document.load_page(page_number - 1)
        longest = max(page.rect.width, page.rect.height, 1)
        scale = max_dimension / longest
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        sys.stdout.buffer.write(pixmap.tobytes("jpeg", jpg_quality=84))
    finally:
        document.close()


def paragraph_text(paragraph: ET.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        if node.tag == f"{{{W_NS}}}t" and node.text:
            parts.append(node.text)
        elif node.tag == f"{{{W_NS}}}tab":
            parts.append("\t")
        elif node.tag in {f"{{{W_NS}}}br", f"{{{W_NS}}}cr"}:
            parts.append("\n")
    return "".join(parts).strip()


def table_lines(table: ET.Element) -> list[str]:
    lines: list[str] = []
    for row in table.findall("./w:tr", NS):
        cells: list[str] = []
        for cell in row.findall("./w:tc", NS):
            paragraphs = [paragraph_text(p) for p in cell.findall(".//w:p", NS)]
            cells.append(" / ".join(value for value in paragraphs if value))
        rendered = " | ".join(cells).strip()
        if rendered:
            lines.append(rendered)
    return lines


def docx_lines(file_path: str) -> list[str]:
    try:
        with zipfile.ZipFile(file_path, "r") as archive:
            names = set(archive.namelist())
            if "word/document.xml" not in names:
                fail("DOCX is missing word/document.xml.")
            xml = archive.read("word/document.xml")
    except zipfile.BadZipFile:
        fail("File is not a valid DOCX/ZIP package.")
    except Exception as exc:
        fail(f"Unable to open DOCX: {exc}")

    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        fail(f"Unable to parse DOCX XML: {exc}")
    body = root.find("w:body", NS)
    if body is None:
        return []

    lines: list[str] = []
    for child in list(body):
        if child.tag == f"{{{W_NS}}}p":
            value = paragraph_text(child)
            if value:
                lines.append(value)
        elif child.tag == f"{{{W_NS}}}tbl":
            lines.extend(table_lines(child))
    return lines


def docx_text(args: list[str]) -> None:
    if len(args) != 4:
        fail("Usage: document-worker.py docx-text <path> <start-line> <end-line-or-0> <max-bytes>")
    file_path, start_raw, end_raw, max_raw = args
    start_line = int(start_raw)
    end_line = int(end_raw)
    max_bytes = max(1000, int(max_raw))
    lines = docx_lines(file_path)
    total_lines = len(lines)
    if total_lines == 0:
        emit_json({
            "total_lines": 0,
            "start_line": 0,
            "end_line": 0,
            "requested_end_line": 0,
            "next_line": None,
            "bytes_returned": 0,
            "truncated": False,
            "lines": [],
        })
        return
    if start_line < 1 or start_line > total_lines:
        fail(f"start_line must be between 1 and {total_lines}.")
    requested_end = total_lines if end_line <= 0 else min(end_line, total_lines)
    if requested_end < start_line:
        fail("end_line must be >= start_line.")

    selected: list[str] = []
    returned_end = start_line - 1
    truncated = False
    for line_number in range(start_line, requested_end + 1):
        value = lines[line_number - 1]
        width = len(str(requested_end))
        rendered = f"{str(line_number).rjust(width)} | {value}"
        candidate = "\n".join([*selected, rendered])
        if len(candidate.encode("utf-8")) <= max_bytes:
            selected.append(rendered)
            returned_end = line_number
            continue
        if not selected:
            bounded, _ = bounded_utf8(rendered, max_bytes)
            selected.append(bounded)
            returned_end = line_number
        truncated = True
        break

    output = "\n".join(selected)
    next_line = returned_end + 1 if returned_end < requested_end else None
    emit_json({
        "total_lines": total_lines,
        "start_line": start_line,
        "end_line": returned_end,
        "requested_end_line": requested_end,
        "next_line": next_line,
        "bytes_returned": len(output.encode("utf-8")),
        "truncated": truncated or next_line is not None,
        "text": output,
    })


def main() -> None:
    if len(sys.argv) < 2:
        fail("Usage: document-worker.py <pdf-text|pdf-render|docx-text> ...")
    mode = sys.argv[1]
    args = sys.argv[2:]
    if mode == "pdf-text":
        pdf_text(args)
    elif mode == "pdf-render":
        pdf_render(args)
    elif mode == "docx-text":
        docx_text(args)
    else:
        fail(f"Unknown document worker mode: {mode}")


if __name__ == "__main__":
    main()
