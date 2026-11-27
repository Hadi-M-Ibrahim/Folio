"""Select visual context after retrieving evidence from the complete policy index."""

import base64
import logging
from io import BytesIO

from pypdf import PdfReader, PdfWriter

from .search import InvalidRequest

# PDF repair warnings can contain bytes from the supplied document.
logging.getLogger("pypdf").setLevel(logging.CRITICAL + 1)

# Small packets are cheap to forward intact. Longer documents are searchable
# in full, but only the candidate pages need visual processing per assessment.
SMALL_PACKET_PAGES = 12


def pdf_pages(attachment, wanted):
    declared = attachment["pages"]
    selected = [n for n in declared if n in wanted]
    if selected == declared:
        return attachment
    try:
        with BytesIO(base64.b64decode(attachment["data"], validate=True)) as source, BytesIO() as output:
            reader = PdfReader(source)
            if len(reader.pages) != len(declared):
                raise ValueError("page count")
            writer = PdfWriter()
            writer.append(reader, pages=[i for i, n in enumerate(declared) if n in wanted],
                          import_outline=False, excluded_fields=["/B"])
            writer.write(output)
            return {**attachment, "pages": selected, "data": base64.b64encode(output.getbuffer()).decode("ascii")}
    except Exception:
        # Parser exceptions can include PDF contents. Report only the corrective action.
        raise InvalidRequest("Folio could not read the selected PDF pages. Re-export the PDF and attach it again.") from None


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
