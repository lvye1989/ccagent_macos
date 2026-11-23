/** Standard-library-only OOXML inspection, embedded so packaged installs remain self-contained. */
export const OFFICE_HELPER_PYTHON = String.raw`#!/usr/bin/env python3
"""Read-only, bounded OOXML inspection. Does not render, calculate, or run macros."""
import argparse
import importlib.util
import json
import os
import platform
import posixpath
import re
import shutil
import stat
import sys
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

MAX_ENTRIES = 10000
MAX_ENTRY_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_XML_NODES = 1000000
MAX_TEXT = 100000
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOC_REL_NS = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
)
MAIN_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
}
MAIN_ROOTS = {"docx": "document", "pptx": "presentation", "xlsx": "workbook"}
DOCUMENT_NAMESPACES = {
    "docx": ("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"),
    "pptx": ("http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main"),
    "xlsx": ("http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"),
}


def fail(message):
    raise ValueError(message)


def local(tag):
    return tag.rsplit("}", 1)[-1]


def namespace(tag):
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def descendants(element, name):
    return (node for node in element.iter() if local(node.tag) == name)


def child(element, name):
    return next((node for node in element if local(node.tag) == name), None)


def relation_id(element):
    return next((element.get("{" + ns + "}id") for ns in DOC_REL_NS if element.get("{" + ns + "}id")), None)


def text_content(element):
    return "".join(node.text or "" for node in descendants(element, "t"))


def package_name(value):
    if not value or "\\" in value or "\x00" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        fail("Unsafe ZIP member path: " + repr(value))
    segments = value.rstrip("/").split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        fail("Unsafe ZIP member path: " + repr(value))
    return value


def target_name(source, target):
    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.query or not parsed.path:
        fail("Invalid internal relationship target: " + repr(target))
    decoded = urllib.parse.unquote(parsed.path)
    if "\\" in decoded or "\x00" in decoded or re.match(r"^/?[A-Za-z]:", decoded):
        fail("Unsafe relationship target: " + repr(target))
    # Absolute OPC part references start at the package root, never the filesystem.
    joined = decoded.lstrip("/") if decoded.startswith("/") else posixpath.join(posixpath.dirname(source), decoded)
    normalized = posixpath.normpath(joined)
    package_name(normalized)
    return normalized


def source_for_relationship(path):
    if path == "_rels/.rels":
        return ""
    parent, filename = posixpath.split(path)
    if posixpath.basename(parent) != "_rels" or not filename.endswith(".rels"):
        fail("Invalid relationship part location: " + path)
    return posixpath.join(posixpath.dirname(parent), filename[:-5])


def root_matches(root, name, namespaces):
    return local(root.tag) == name and namespace(root.tag) in namespaces


def desktop_location():
    candidate = Path.home() / "Desktop"
    source = "home-default"
    warning = None
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
                value, _ = winreg.QueryValueEx(key, "Desktop")
            expanded = os.path.expandvars(value)
            if not expanded or not os.path.isabs(expanded) or "%" in expanded:
                fail("Windows Desktop registry value is not an absolute resolved path")
            candidate = Path(expanded)
            source = "windows-user-shell-folders"
        except (OSError, ValueError, ImportError) as error:
            warning = str(error)
    elif sys.platform != "darwin":
        config_base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config"))
        config = config_base / "user-dirs.dirs"
        try:
            if config.is_file():
                with config.open("r", encoding="utf-8") as stream:
                    data = stream.read(65537)
                if len(data) > 65536:
                    fail("XDG user directory config exceeds the read limit")
                match = re.search(r'^\s*XDG_DESKTOP_DIR\s*=\s*"([^"\r\n]*)"\s*(?:#.*)?$', data, re.M)
                if match:
                    # Expand environment values only; never execute or source this shell file.
                    expanded = os.path.expandvars(match.group(1)).replace("\\ ", " ")
                    if not expanded or "$" in expanded or not os.path.isabs(expanded):
                        fail("XDG desktop directory is not an absolute resolved path")
                    candidate = Path(expanded)
                    source = "xdg-user-dirs"
        except (OSError, ValueError, UnicodeError) as error:
            warning = str(error)
    result = {"path": str(candidate.expanduser().resolve()), "exists": candidate.is_dir(), "source": source}
    if warning:
        result["warning"] = warning
    return result


def probe():
    modules = {}
    for name in ("docx", "pptx", "openpyxl"):
        try:
            spec = importlib.util.find_spec(name)
            modules[name] = {"available": spec is not None, "origin": str(spec.origin) if spec and spec.origin else None}
        except (ImportError, ValueError, AttributeError) as error:
            modules[name] = {"available": False, "error": str(error)}
    apps = {}
    for name, bundles, commands in (
        ("word", ("Microsoft Word.app",), ("winword", "WINWORD.EXE")),
        ("excel", ("Microsoft Excel.app",), ("excel", "EXCEL.EXE")),
        ("powerpoint", ("Microsoft PowerPoint.app",), ("powerpnt", "POWERPNT.EXE")),
        ("libreoffice", ("LibreOffice.app",), ("libreoffice",)),
        ("soffice", (), ("soffice",)),
    ):
        paths = []
        for bundle in bundles:
            for base in (Path("/Applications"), Path.home() / "Applications"):
                candidate = base / bundle
                if candidate.is_dir():
                    paths.append(str(candidate))
        for command in commands:
            executable = shutil.which(command)
            if executable and executable not in paths:
                paths.append(executable)
        if name == "soffice":
            for base in (Path("/Applications"), Path.home() / "Applications"):
                executable = base / "LibreOffice.app/Contents/MacOS/soffice"
                if executable.is_file():
                    paths.append(str(executable))
        apps[name] = {"available": bool(paths), "paths": paths}
    return {"ok": True, "command": "probe", "python": {"executable": sys.executable, "version": platform.python_version(), "platform": platform.system()}, "desktop": desktop_location(), "modules": modules, "applications": apps}


class Package:
    def __init__(self, path, kind):
        self.path = path
        self.kind = kind
        self.parts = {}
        self.xml = {}
        self.relationships = {}
        self.external = []
        self.types = {}
        self.total = 0
        self.node_count = 0
        self.text_budget = MAX_TEXT
        with zipfile.ZipFile(path, "r") as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ENTRIES:
                fail("ZIP has too many entries (limit " + str(MAX_ENTRIES) + ")")
            seen = set()
            for info in entries:
                package_name(info.filename)
                folded = info.filename.casefold()
                if folded in seen:
                    fail("Duplicate or case-colliding ZIP member: " + info.filename)
                seen.add(folded)
                if info.flag_bits & 1:
                    fail("Encrypted ZIP members are unsupported")
                if stat.S_ISLNK(info.external_attr >> 16):
                    fail("ZIP symlinks are unsupported")
                if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    fail("Unsupported ZIP compression method")
                if info.file_size > MAX_ENTRY_BYTES:
                    fail("ZIP member exceeds the uncompressed size limit: " + info.filename)
                if info.file_size > 1024 * 1024 and info.file_size > max(1, info.compress_size) * 200:
                    fail("Suspicious ZIP compression ratio: " + info.filename)
                self.total += info.file_size
                if self.total > MAX_TOTAL_BYTES:
                    fail("ZIP exceeds the total uncompressed size limit")
                if info.is_dir():
                    continue
                with archive.open(info, "r") as stream:
                    data = stream.read(MAX_ENTRY_BYTES + 1)
                if len(data) > MAX_ENTRY_BYTES or len(data) != info.file_size:
                    fail("ZIP member size mismatch or size limit exceeded")
                self.parts[info.filename] = data
        if "[Content_Types].xml" not in self.parts or "_rels/.rels" not in self.parts:
            fail("Missing OOXML content types or package relationships")
        for name, data in self.parts.items():
            if name.lower().endswith((".xml", ".rels", ".vml")):
                self.parse_xml(name, data)
        self.check_types()
        self.check_relationships()
        main = [rel for rel in self.relationships.get("", {}).values() if rel["type"].endswith("/officeDocument")]
        if len(main) != 1 or main[0]["external"]:
            fail("Package must have exactly one internal officeDocument relationship")
        self.main = main[0]["target"]
        if self.types.get(self.main) != MAIN_TYPES[kind]:
            fail("Main document content type does not match ." + kind)
        if not root_matches(self.xml.get(self.main, ET.Element("missing")), MAIN_ROOTS[kind], DOCUMENT_NAMESPACES[kind]):
            fail("Invalid main document XML root or namespace")

    def parse_xml(self, name, data):
        # Remove NULs to detect UTF-16/32 DTDs as well as UTF-8 XML.
        normalized = data.replace(b"\x00", b"")
        if re.search(br"<!\s*(DOCTYPE|ENTITY)\b", normalized, re.I):
            fail("DTD/entity declarations are unsupported: " + name)
        try:
            root = ET.fromstring(data)
        except ET.ParseError as error:
            fail("Malformed XML in " + name + ": " + str(error))
        self.node_count += sum(1 for _ in root.iter())
        if self.node_count > MAX_XML_NODES:
            fail("XML node count exceeds the safety limit")
        self.xml[name] = root

    def check_types(self):
        root = self.xml["[Content_Types].xml"]
        if root.tag != "{" + CT_NS + "}Types":
            fail("Invalid OOXML content types root")
        defaults = {}
        overrides = {}
        for node in root:
            content_type = node.get("ContentType")
            if not content_type:
                fail("Empty content type declaration")
            if node.tag == "{" + CT_NS + "}Default":
                extension = node.get("Extension", "").lower()
                if not extension or extension in defaults:
                    fail("Invalid or duplicate content type extension")
                defaults[extension] = content_type
            elif node.tag == "{" + CT_NS + "}Override":
                raw_name = node.get("PartName", "")
                if not raw_name.startswith("/"):
                    fail("Content type override must use an absolute part name")
                name = target_name("", raw_name)
                if name not in self.parts or name in overrides:
                    fail("Missing or duplicate overridden part: " + name)
                overrides[name] = content_type
            else:
                fail("Invalid content type declaration")
        for name in self.parts:
            if name == "[Content_Types].xml":
                continue
            content_type = overrides.get(name) or defaults.get(name.rsplit(".", 1)[-1].lower())
            if not content_type:
                fail("Part has no declared content type: " + name)
            self.types[name] = content_type
            if (content_type.endswith("+xml") or content_type in ("application/xml", "text/xml")) and name not in self.xml:
                self.parse_xml(name, self.parts[name])

    def check_relationships(self):
        for name, root in self.xml.items():
            if not name.endswith(".rels"):
                continue
            if root.tag != "{" + PKG_REL_NS + "}Relationships":
                fail("Invalid relationships root: " + name)
            source = source_for_relationship(name)
            if source and source not in self.parts:
                fail("Relationship source part does not exist: " + source)
            relationships = {}
            for node in root:
                if node.tag != "{" + PKG_REL_NS + "}Relationship":
                    fail("Invalid relationship element: " + name)
                identity, kind, raw_target = node.get("Id"), node.get("Type"), node.get("Target")
                mode = node.get("TargetMode", "Internal")
                if not identity or not kind or not raw_target or identity in relationships or mode not in ("Internal", "External"):
                    fail("Invalid or duplicate relationship: " + name)
                external = mode == "External"
                target = raw_target if external else target_name(source, raw_target)
                if not external and target not in self.parts:
                    fail("Missing internal relationship target: " + target)
                relationships[identity] = {"type": kind, "target": target, "external": external}
                if external:
                    self.external.append({"source": source, "id": identity, "type": kind})
            self.relationships[source] = relationships

    def referenced(self, source, node, relation_suffix):
        identity = relation_id(node)
        relation = self.relationships.get(source, {}).get(identity)
        if not relation or relation["external"] or not relation["type"].endswith("/" + relation_suffix):
            fail("Missing or invalid " + relation_suffix + " relationship in " + source)
        return relation["target"]

    def sample(self, text, limit=1000):
        value = text[:min(limit, self.text_budget)]
        self.text_budget -= len(value)
        return value

    def describe(self):
        return {"part_count": len(self.parts), "xml_part_count": len(self.xml), "uncompressed_bytes": self.total, "main_part": self.main, "external_relationship_count": len(self.external), "macros_present": any("vbaproject" in name.lower() or "vbaProject" in value for name, value in self.types.items()), "embedded_object_count": sum("/embeddings/" in name for name in self.parts), "limits": {"entries": MAX_ENTRIES, "entry_bytes": MAX_ENTRY_BYTES, "total_bytes": MAX_TOTAL_BYTES}}


def inspect_word(package):
    body = child(package.xml[package.main], "body")
    if body is None:
        fail("Word document has no body")
    paragraphs = list(descendants(body, "p"))
    tables = list(descendants(body, "tbl"))
    samples = []
    for paragraph in paragraphs:
        text = text_content(paragraph)
        if text.strip() and len(samples) < 20:
            samples.append(package.sample(text, 500))
    return {"paragraph_count": len(paragraphs), "table_count": len(tables), "text_samples": samples, "header_footer_part_count": sum(bool(re.search(r"/(header|footer)[^/]*\.xml$", name)) for name in package.parts), "comment_parts": [name for name in package.parts if "/comments" in name], "tracked_change_count": sum(local(node.tag) in ("ins", "del", "moveFrom", "moveTo") for root in package.xml.values() for node in root.iter())}


def inspect_presentation(package):
    root = package.xml[package.main]
    slide_list = child(root, "sldIdLst")
    result = []
    seen_ids = set()
    seen_parts = set()
    for node in slide_list if slide_list is not None else []:
        if local(node.tag) != "sldId" or not node.get("id") or node.get("id") in seen_ids:
            fail("Invalid or duplicate presentation slide identifier")
        seen_ids.add(node.get("id"))
        target = package.referenced(package.main, node, "slide")
        if target in seen_parts:
            fail("Presentation references the same slide more than once")
        seen_parts.add(target)
        slide = package.xml.get(target)
        if slide is None or not root_matches(slide, "sld", DOCUMENT_NAMESPACES["pptx"]):
            fail("Invalid slide XML: " + target)
        texts = [text_content(paragraph) for paragraph in descendants(slide, "p")]
        text = "\n".join(value for value in texts if value)
        sample = package.sample(text, 2000)
        result.append({"number": len(result) + 1, "part": target, "text": sample, "text_truncated": len(sample) < len(text)})
    return {"slide_count": len(result), "slides": result, "order_source": "presentation slide relationships"}


def inspect_workbook(package):
    root = package.xml[package.main]
    sheets = child(root, "sheets")
    if sheets is None:
        fail("Workbook has no sheets collection")
    shared = []
    for relation in package.relationships.get(package.main, {}).values():
        if relation["type"].endswith("/sharedStrings") and not relation["external"]:
            shared_root = package.xml.get(relation["target"])
            if shared_root is None or not root_matches(shared_root, "sst", DOCUMENT_NAMESPACES["xlsx"]):
                fail("Invalid shared strings XML")
            shared = [text_content(item) for item in shared_root if local(item.tag) == "si"]
    result = []
    names, ids = set(), set()
    formula_total = error_total = missing_total = 0
    for sheet in sheets:
        name, identity = sheet.get("name"), sheet.get("sheetId")
        if local(sheet.tag) != "sheet" or not name or not identity or name.casefold() in names or identity in ids:
            fail("Invalid or duplicate workbook sheet")
        names.add(name.casefold())
        ids.add(identity)
        relation = package.relationships.get(package.main, {}).get(relation_id(sheet))
        if not relation or relation["external"] or not relation["type"].endswith(("/worksheet", "/chartsheet", "/dialogsheet", "/macrosheet")):
            fail("Invalid workbook sheet relationship: " + name)
        target = relation["target"]
        sheet_root = package.xml.get(target)
        kind = relation["type"].rsplit("/", 1)[-1]
        if sheet_root is None or not root_matches(sheet_root, kind, DOCUMENT_NAMESPACES["xlsx"]):
            fail("Invalid sheet XML: " + target)
        formulas = errors = missing = cells = max_row = max_col = 0
        samples = []
        seen_cells = set()
        for cell in descendants(sheet_root, "c"):
            reference = cell.get("r", "")
            match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]{0,6})", reference)
            if not match or reference in seen_cells:
                fail("Invalid or duplicate cell reference in " + name + ": " + reference)
            seen_cells.add(reference)
            column = 0
            for character in match.group(1):
                column = column * 26 + ord(character) - ord("A") + 1
            row = int(match.group(2))
            if column > 16384 or row > 1048576:
                fail("Cell exceeds Excel worksheet limits: " + reference)
            max_col, max_row = max(max_col, column), max(max_row, row)
            cells += 1
            formula, value = child(cell, "f"), child(cell, "v")
            has_formula = formula is not None
            raw = value.text if value is not None else None
            if has_formula:
                formulas += 1
                if raw is None or raw == "":
                    missing += 1
            if cell.get("t") == "e":
                errors += 1
            display = raw
            if cell.get("t") == "s":
                if raw is None or not raw.isdigit() or int(raw) >= len(shared):
                    fail("Invalid shared string reference at " + name + "!" + reference)
                display = shared[int(raw)]
            elif cell.get("t") == "inlineStr":
                display = text_content(cell)
            if len(samples) < 12:
                item = {"cell": reference, "type": cell.get("t", "n"), "value_sample": package.sample(display or "", 200)}
                if has_formula:
                    item["formula_sample"] = package.sample(formula.text or "", 200)
                    item["cached_value_present"] = raw is not None and raw != ""
                samples.append(item)
        dimension = child(sheet_root, "dimension")
        result.append({"name": name, "state": sheet.get("state", "visible"), "kind": kind, "part": target, "declared_dimension": dimension.get("ref") if dimension is not None else None, "observed_rows": max_row, "observed_columns": max_col, "cell_count": cells, "formula_count": formulas, "error_cell_count": errors, "formula_missing_cached_value_count": missing, "cell_samples": samples})
        formula_total += formulas
        error_total += errors
        missing_total += missing
    return {"sheet_count": len(result), "sheets": result, "formula_count": formula_total, "error_cell_count": error_total, "formula_missing_cached_value_count": missing_total, "formulas_calculated": False}


def inspect_file(path_string, command):
    path = Path(path_string).expanduser().resolve(strict=True)
    if not path.is_file():
        fail("Input is not a regular file")
    kind = path.suffix.lower().lstrip(".")
    if kind not in MAIN_TYPES:
        fail("Supported formats are .docx, .pptx and .xlsx; convert other formats with a real supported application")
    package = Package(path, kind)
    summary = {"docx": inspect_word, "pptx": inspect_presentation, "xlsx": inspect_workbook}[kind](package)
    return {"ok": True, "command": command, "path": str(path), "format": kind, "package": package.describe(), "summary": summary, "validation": {"scope": "bounded ZIP, XML, content types, internal relationships and basic document structure", "rendered": False, "formulas_recalculated": False, "application_compatibility_verified": False}, "limitations": ["Structural checks are not full OOXML schema or visual validation.", "No rendering, formula calculation, macro execution or external-link fetching was performed.", "Text and cell values are bounded samples; missing formula caches do not imply zero or a correct result."]}


class JsonParser(argparse.ArgumentParser):
    def error(self, message):
        fail(message)


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        parser = JsonParser(description=__doc__)
        subparsers = parser.add_subparsers(dest="command", required=True)
        subparsers.add_parser("probe", help="Check Python, optional modules and local applications without installing anything")
        for name in ("inspect", "validate"):
            item = subparsers.add_parser(name, help="Read-only OOXML structure checks and bounded content summary")
            item.add_argument("file", help="Existing DOCX, PPTX or XLSX path (quote paths containing spaces)")
        args = parser.parse_args()
        result = probe() if args.command == "probe" else inspect_file(args.file, args.command)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "command": command, "error": str(error), "error_type": type(error).__name__}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
`;
