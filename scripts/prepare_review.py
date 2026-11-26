"""Prepare a private review bundle from the supplied local PDFs.

    python -m pip install -r requirements/pdf.txt
    python scripts/prepare_review.py catalog
    python scripts/prepare_review.py questionnaire --questions 1-5
    python scripts/prepare_review.py guide --pages 11

Import the resulting .local-review/ JSON in the localhost workspace. All PDF
processing happens in this process. The SQLite FTS5 index lives only in memory.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
from contextlib import ExitStack, closing
from itertools import zip_longest
from pathlib import Path

if __name__ == "__main__" and not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api._review.search import (
    ADVERSE,
    MAX_CHARS,
    MAX_DOCUMENTS,
    MAX_PAGE_CHARS,
    MAX_PAGES,
    STOP,
    guide_criteria,
    validate,
    words,
)
from api.review import MAX_BODY

ROOT = Path(__file__).resolve().parents[1]

QUESTION = re.compile(
    r"^(\d+)[.)]\s+((?:does|do|is|are|what|which|how|when|who|can|should|describe|provide)\b.*)",
    re.I,
)
ANSWER_FIELD = re.compile(r"\(references?\s*:|^\s*(?:☐\s*)?yes\s+(?:☐\s*)?no\b", re.I)
FOOTER = re.compile(r"(?:rev\.?\s*\d+/\d+|(?:page\s+)?\d+(?:\s+of\s+\d+)?)", re.I)


def open_pdf(path):
    try:
        import pymupdf
    except ImportError:
        sys.exit("Install local PDF support with python -m pip install -r requirements/pdf.txt")
    return pymupdf.open(path)


def read_questions(pdf):
    items = {}
    active = None
    for page in pdf:
        for line in page.get_text(sort=True).splitlines():
            line = " ".join(line.split())
            if not line or FOOTER.fullmatch(line):
                continue
            begin = QUESTION.match(line)
            if begin:
                active = int(begin[1])
                items[active] = []
                line = begin[2]
            if active is None:
                continue
            fence = ANSWER_FIELD.search(line)
            text = line[:fence.start()].strip() if fence else line
            if text:
                items[active].append(text)
            if fence:
                active = None
    return {n: " ".join(parts) for n, parts in items.items() if parts}


def material_pdfs(materials, candidates):
    root = materials.resolve()
    files = sorted(p for p in candidates if p.suffix.lower() == ".pdf" and p.is_file())
    if any(not path.resolve().is_relative_to(root) for path in files):
        raise ValueError("A PDF points outside the selected materials directory.")
    return files


def source_pair(materials, stack):
    sources = material_pdfs(materials, materials.iterdir())
    if len(sources) != 2:
        raise ValueError("The materials folder must contain a guide and a questionnaire PDF at its top level.")
    # Inspect the shorter source first to avoid parsing the entire guide for form fields.
    opened = sorted((stack.enter_context(open_pdf(p)) for p in sources), key=len)
    for index, pdf in enumerate(opened):
        items = read_questions(pdf)
        if items and sorted(items) == list(range(1, len(items) + 1)):
            return opened[1 - index], items
    raise ValueError("Could not identify a consecutively numbered questionnaire in the two PDFs.")


def select_numbers(value, maximum):
    numbers = set()
    for part in value.split(","):
        match = re.fullmatch(r"\s*(\d+)(?:\s*-\s*(\d+))?\s*", part)
        if not match:
            raise ValueError("Use numbers or inclusive ranges separated by commas, for example 2,5-8.")
        first, last = int(match[1]), int(match[2] or match[1])
        if not 1 <= first <= last <= maximum:
            raise ValueError(f"Selections must be increasing ranges between 1 and {maximum}.")
        numbers.update(range(first, last + 1))
    return sorted(numbers)


def page_text(page):
    # Keep PDF paragraph boundaries while joining visual line wraps for passage search.
    return "\n\n".join(
        " ".join(block[4].split())
        for block in page.get_text("blocks", sort=True)
        if block[6] == 0 and block[4].strip()
    )


def catalog(guide, questions):
    print(f"Guide ({len(guide)} physical pages). Select physical pages with --pages.")
    seen = set()
    for _, title, page in guide.get_toc():
        if page > 0 and title not in seen:
            seen.add(title)
            print(f"  {page:3d}  {' '.join(title.split())}")
    print(f"\nQuestionnaire ({len(questions)} items). Select original numbers with --questions.")
    for number, question in questions.items():
        print(f"  {number:3d}  {question}")


def prepare_criteria(args, guide, questions):
    payload = {"mode": args.mode, "allowModel": False}
    if args.mode == "questionnaire":
        numbers = select_numbers(args.questions, max(questions))
        payload["questions"] = [f"{n}. {questions[n]}" for n in numbers]
        payload["selection"] = {"questionNumbers": numbers}
        criteria = [questions[n] for n in numbers]
    else:
        numbers = select_numbers(args.pages, len(guide))
        pages = [{"number": n, "text": page_text(guide[n - 1])} for n in numbers]
        text = "\n\n".join(page["text"] for page in pages)
        payload["guide"] = text
        payload["sourceDocument"] = {"id": "submitted-guide", "title": Path(guide.name).name, "pages": pages}
        payload["selection"] = {"guidePages": numbers}
        criteria = [clause for clause, _ in guide_criteria(text)]
        if not criteria:
            raise ValueError("No explicit duty found for selecting policy pages. Choose a different section or upload the guide directly to Folio.")
    return payload, criteria


def read_corpus(materials):
    policies = material_pdfs(materials, (p for p in materials.rglob("*") if p.parent != materials))
    if not policies:
        raise ValueError("Place the policy PDFs in subdirectories of the materials folder.")
    pages = {}
    all_pages = 0
    for i, path in enumerate(policies, 1):
        title = path.relative_to(materials).as_posix()
        with open_pdf(path) as doc:
            all_pages += len(doc)
            for n, page in enumerate(doc, 1):
                text = page_text(page)
                if text:
                    pages[(f"policy-{i:04d}", n)] = (title, text)
    return pages, {"sourceDocuments": len(policies), "sourcePages": all_pages, "searchablePages": len(pages)}


def ranked_pages(pages, criteria):
    keys = list(pages)
    with closing(sqlite3.connect(":memory:")) as db:
        db.execute("CREATE VIRTUAL TABLE corpus USING fts5(body, title, tokenize='porter unicode61')")
        db.executemany("INSERT INTO corpus(rowid,body,title) VALUES(?,?,?)",
                       ((i, text, title) for i, (title, text) in enumerate(pages.values(), 1)))
        for query in criteria:
            terms = dict.fromkeys(w for w in words(query) if len(w) > 1 and w not in STOP)
            if not terms:
                yield []
                continue
            expression = " OR ".join(f'"{t}"' for t in terms)
            rows = db.execute(
                "SELECT rowid FROM corpus WHERE corpus MATCH ? "
                "ORDER BY bm25(corpus, 1.0, 1.5), rowid LIMIT 40",
                (expression,),
            )
            ranked = [keys[rowid - 1] for (rowid,) in rows]
            exceptions = [key for key in ranked if ADVERSE.search(pages[key][1])]
            yield list(dict.fromkeys(ranked[:6] + exceptions[:2]))


def shortlist(pages, criteria):
    documents = {}
    selected = set()
    characters = 0
    rankings = list(ranked_pages(pages, criteria))
    # Give every criterion a first pick before considering second picks.
    for rank in zip_longest(*rankings):
        for key in rank:
            if key is None or key in selected:
                continue
            doc_id, n = key
            title, text = pages[key]
            if doc_id not in documents and len(documents) >= MAX_DOCUMENTS:
                continue
            if len(text) > MAX_PAGE_CHARS or characters + len(text) > MAX_CHARS or len(selected) >= MAX_PAGES:
                continue
            document = documents.setdefault(doc_id, {"id": doc_id, "title": title, "pages": []})
            document["pages"].append({"number": n, "text": text})
            characters += len(text)
            selected.add(key)
    if not selected:
        raise ValueError("No eligible policy pages were found for this selection.")
    for doc in documents.values():
        doc["pages"].sort(key=lambda p: p["number"])
    unrepresented = sum(not selected.intersection(ranked) for ranked in rankings)
    return list(documents.values()), len(selected), unrepresented


def save_private(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
    if len(encoded) > MAX_BODY:
        raise ValueError("This review exceeds the API request byte limit. Use a smaller selection.")
    directory = ROOT / ".local-review"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink():
        raise ValueError("The private bundle directory must be a directory inside the project.")
    destination = directory / f"{payload['mode']}.json"
    f = tempfile.NamedTemporaryFile(dir=directory, delete=False)
    staging = Path(f.name)
    try:
        with f:
            f.write(encoded)
        os.replace(staging, destination)
    finally:
        staging.unlink(missing_ok=True)
    return destination.relative_to(ROOT)


def main():
    parser = argparse.ArgumentParser(description="Prepare a review from local guide, questionnaire, and policy PDFs.")
    parser.add_argument("--materials", type=Path, default=ROOT / "Materials")
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("catalog", help="Print the private guide outline and original questions to this terminal.")
    sub.add_parser("questionnaire").add_argument("--questions", required=True, help="Original numbers, e.g. 1-5,9")
    sub.add_parser("guide").add_argument("--pages", required=True, help="One-based physical guide pages, e.g. 11")
    args = parser.parse_args()
    with ExitStack() as stack:
        guide, questions = source_pair(args.materials, stack)
        if args.mode == "catalog":
            catalog(guide, questions)
            return
        payload, criteria = prepare_criteria(args, guide, questions)
    pages, scope = read_corpus(args.materials)
    documents, selected, unrepresented = shortlist(pages, criteria)
    scope.update(selectedDocuments=len(documents), selectedPages=selected,
                 criteriaWithoutSelectedCandidate=unrepresented)
    payload.update(documents=documents, corpusScope=scope)
    validate(payload)
    path = save_private(payload)
    print(f"Read {scope['sourceDocuments']} policy PDFs, {scope['searchablePages']:,} searchable pages "
          f"of {scope['sourcePages']:,} total. Selected {selected} pages from {len(documents)} PDFs "
          f"for {len(criteria)} criteria.")
    if unrepresented:
        print(f"{unrepresented} criteria had no shortlisted page within the limits. Try a smaller selection.")
    print(f"Import {path} in the localhost workspace. Its search trail covers the selected pages.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, sqlite3.Error) as error:
        sys.exit(str(error))
