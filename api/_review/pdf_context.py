"""Select visual context after retrieving evidence from the complete policy index."""

import base64
import logging
from contextlib import contextmanager
from io import BytesIO

from pypdf import PdfReader, PdfWriter, apply_configuration

from .search import MAX_PDF_PAGES, InvalidRequest

# PDF repair warnings can contain bytes from the supplied document.
logging.getLogger("pypdf").setLevel(logging.CRITICAL + 1)

# Small packets are cheap to forward intact. Longer documents are searchable
# in full, but only the candidate pages need visual processing per assessment.
SMALL_PACKET_PAGES = 12


@contextmanager
def checked_pdf(attachment):
    # Include internal page-tree nodes in the work limit. A large or incorrect
    # /Count alone must never authorize forwarding the original bytes.
    with apply_configuration(page_tree_maximum_entries=4 * MAX_PDF_PAGES):
        try:
            with (
                BytesIO(base64.b64decode(attachment["data"], validate=True)) as source,
                PdfReader(source, strict=True) as reader,
            ):
                if reader.is_encrypted and not reader.decrypt(""):
                    raise ValueError("locked PDF")
                if len(reader.pages) != len(attachment["pages"]):
                    raise ValueError("page count")
                yield reader
        except Exception:
            # Parser and writer exceptions can contain bytes from the supplied document.
            raise InvalidRequest("Folio could not verify the selected PDF pages. Re-export the PDF and attach it again.") from None


def verify_pdf_page_counts(attachments):
    # Check the whole packet before any part of this review goes to the provider.
    for attachment in attachments:
        with checked_pdf(attachment):
            pass


def pdf_pages(attachment, wanted):
    declared = attachment["pages"]
    selected = [n for n in declared if n in wanted]
    if selected == declared:
        return attachment
    with checked_pdf(attachment) as reader, BytesIO() as output, PdfWriter() as writer:
        writer.append(reader, pages=[i for i, n in enumerate(declared) if n in wanted],
                      import_outline=False, excluded_fields=["/B"])
        writer.write(output)
        return {**attachment, "pages": selected, "data": base64.b64encode(output.getbuffer()).decode("ascii")}


def assessment_pdfs(attachments, assignments):
    if sum(len(pdf["pages"]) for pdf in attachments) <= SMALL_PACKET_PAGES:
        return attachments
    relevant = {}
    for row in assignments:
        for passage in row["passages"]:
            relevant.setdefault(passage["documentId"], set()).add(passage["page"])
    context = []
    for pdf in attachments:
        if pdf["role"] == "source":
            context.append(pdf)
        elif pdf["documentId"] in relevant:
            context.append(pdf_pages(pdf, relevant[pdf["documentId"]]))
    return context
