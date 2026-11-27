import base64
import io
import json
import os
import unittest
from unittest.mock import patch

from api import review as api
from api._review import model, pdf_reader, search

QUESTION = "Does the clerk stamp every parcel before dispatch?"
RULE = "The clerk stamps every parcel before dispatch. See Appendix B for fragile items."
ANNEX = "Appendix B. Fragile items go unmarked to prevent damage."
PLAN = {"criteria": [{"sourceId": "s1", "searchTerms": ["parcel"]}]}
SUPPORT = {"id": "q1", "status": "supported", "answer": "The clerk stamps each parcel.",
           "supporting": [{"passage": "p1", "quote": RULE}], "counter": []}


def pdf_attachment(role, numbers):
    # Make standalone, blank PDF pages; the transport mock supplies the visible text in scanner tests.
    refs = " ".join(f"{n + 3} 0 R" for n in range(len(numbers)))
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", f"<< /Type /Pages /Count {len(numbers)} /Kids [{refs}] >>",
               *(["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>"] * len(numbers))]
    raw = bytearray(f"%PDF-1.4\n% {role}\n".encode())
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(raw))
        raw.extend(f"{i} 0 obj\n{obj}\nendobj\n".encode())
    xref = len(raw)
    raw.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        raw.extend(f"{offset:010d} 00000 n \n".encode())
    raw.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return {"role": role, "documentId": role + "-id", "title": role + ".pdf",
            "pages": numbers, "data": base64.b64encode(raw).decode()}


def payload():
    return {
        "mode": "questionnaire", "questions": [QUESTION], "allowModel": True, "modelSharingConsent": True,
        "pdfAttachments": [pdf_attachment("source", [5]), pdf_attachment("policy", [2, 17])],
        "documents": [{"id": "policy-id", "title": "policy.pdf", "pages": [
            {"number": 2, "text": RULE}, {"number": 17, "text": ANNEX},
        ]}],
    }


class PdfReviewTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test-key", "VERCEL": "1"}, clear=True))

    def run_provider(self, submission, outputs):
        calls = []
        def respond(outgoing, *, timeout):
            body = json.loads(outgoing.data)
            tool = body["tools"][0]["name"]
            content = body["messages"][0]["content"]
            data = content[-1]["text"] if isinstance(content, list) else content
            docs = content[:-1] if isinstance(content, list) else []
            calls.append((tool, docs, json.loads(data)))
            output = outputs[len(calls) - 1]
            return io.BytesIO(json.dumps({"stop_reason": "tool_use", "content": [
                {"type": "tool_use", "name": tool, "input": output},
            ]}).encode())
        with patch.object(model, "open_provider_request", side_effect=respond):
            result = api.review(submission)
        self.assertEqual(len(calls), len(outputs))
        for attachment in submission.get("pdfAttachments", []):
            self.assertNotIn(attachment["data"], json.dumps(result))
        return result, calls

    def assert_documents(self, blocks, attachments):
        self.assertEqual(len(attachments), len(blocks))
        for i, attachment in enumerate(attachments):
            block = blocks[i]
            self.assertEqual((block["type"], block["title"]), ("document", attachment["title"]))
            self.assertEqual(json.loads(block["context"]), {k: attachment[k] for k in ("role", "documentId", "pages")})
            self.assertEqual(block["source"], {"type": "base64", "media_type": "application/pdf", "data": attachment["data"]})

    def test_native_pdf_roles_scope_and_original_pages_survive_followup(self):
        request = payload()
        first = {**SUPPORT, "followup": {"passage": "p1", "reason": "cross_reference", "term": "Appendix B"}}
        result, calls = self.run_provider(request, [PLAN, {"assessments": [first]}, {"assessments": [SUPPORT]}])
        self.assertEqual([tool for tool, _, _ in calls], ["record_search_plan", "record_review", "record_review"])
        self.assert_documents(calls[0][1], request["pdfAttachments"][:1])
        self.assertEqual([unit["text"] for unit in calls[0][2]["sources"]], [QUESTION])
        for _, blocks, rows in calls[1:]:
            self.assert_documents(blocks, request["pdfAttachments"])
            self.assertEqual(rows[0]["criterion"], QUESTION)
            self.assertEqual(rows[0]["passages"][0]["page"], 2)
        self.assertEqual(calls[-1][2][0]["passages"][-1]["page"], 17)
        self.assertEqual(result["findings"][0]["supporting"][0]["page"], 2)
        self.assertNotIn("policyPageText", result)

    def test_pdf_context_cannot_supply_an_unverified_quotation(self):
        wrong = {**SUPPORT, "supporting": [{"passage": "p1", "quote": QUESTION}]}
        result, _ = self.run_provider(payload(), [PLAN, {"assessments": [wrong]}])
        finding, = result["findings"]
        self.assertEqual((finding["status"], finding["supporting"]), ("needs_review", []))

    def test_scans_read_just_missing_policy_pages_and_restore_citable_source(self):
        request = payload()
        del request["questions"]
        request["readSourcePdf"] = True
        request["documents"][0]["pages"][0]["text"] = ""
        source_rows = [{"number": 5, "text": "Shipping form\n" + QUESTION.replace("parcel ", "parcel\n")}]
        policy_rows = [{"number": 2, "text": RULE}]
        result, calls = self.run_provider(request, [
            {"pages": source_rows, "questions": [QUESTION]}, {"pages": policy_rows}, PLAN, {"assessments": [SUPPORT]},
        ])
        source, policy = request["pdfAttachments"]
        for i, (attachment, numbers) in enumerate(((source, [5]), (policy, [2]))):
            tool, blocks, data = calls[i]
            self.assertEqual(tool, "record_pdf_pages")
            self.assertEqual(data["pages"], numbers)
            self.assert_documents(blocks, [attachment])
        self.assert_documents(calls[2][1], [source])
        self.assert_documents(calls[3][1], [source, policy])
        self.assertEqual(result["sourcePages"], source_rows)
        self.assertEqual(result["questions"], [QUESTION])
        self.assertEqual(result["policyPageText"], [{"documentId": "policy-id", "pages": policy_rows}])
        self.assertEqual(result["findings"][0]["supporting"][0]["quote"], RULE)
        self.assertIn("original PDF pages", result["notice"])

    def test_mixed_guide_preserves_page_order_and_offsets_during_policy_comparison(self):
        source = pdf_attachment("source", [7, 9])
        request = {**payload(), "readSourcePdf": True, "mode": "guide", "pdfAttachments": [source]}
        del request["questions"]
        duty = "The office must retain records."
        rows = [{"number": 7, "text": "📋 Paperwork."}, {"number": 9, "text": duty}]
        plan = {"criteria": [{"sourceId": "s2", "question": "Are records retained?", "searchTerms": ["records"]}]}
        result, calls = self.run_provider(request, [{"pages": rows}, plan, {"assessments": [SUPPORT]}])
        self.assertEqual(result["sourcePages"], rows)
        self.assertEqual(result["guide"], "\n\n".join(row["text"] for row in rows))
        finding, = result["findings"]
        self.assertEqual(result["guide"][finding["criterionStart"]:finding["criterionEnd"]], duty)
        self.assert_documents(calls[1][1], [source])

    def test_guide_transcription_can_omit_policies_but_cannot_be_used_to_review_obligations(self):
        source = pdf_attachment("source", [2])
        part = {"mode": "guide", "readSourcePdf": True, "documentPart": True, "documents": [],
                "allowModel": True, "modelSharingConsent": True, "pdfAttachments": [source]}
        with patch.object(model, "invoke_tool") as invoke, self.assertRaisesRegex(search.InvalidRequest, "at least one existing policy"):
            api.review(part)
        invoke.assert_not_called()
        rows = [{"number": 2, "text": "Staff must retain forms."}]
        result, calls = self.run_provider({**part, "transcribeSourceOnly": True}, [{"pages": rows}])
        self.assertEqual([tool for tool, _, _ in calls], ["record_pdf_pages"])
        self.assertEqual(result["sourcePages"], rows)
        self.assertEqual(result["findings"], [])

    def test_consent_controls_pdf_transport_and_scanning(self):
        request = payload()
        with patch.object(model, "open_provider_request") as send:
            for flag in ("allowModel", "modelSharingConsent"):
                self.assertEqual(api.review({**request, flag: False})["engine"], "local")
            del request["questions"]
            with self.assertRaisesRegex(search.InvalidRequest, "consent"):
                api.review({**request, "readSourcePdf": True, "modelSharingConsent": False, "publicInputConsent": True})
            send.assert_not_called()

    def test_invalid_attachments_never_reach_provider(self):
        request = payload()
        source, policy = request["pdfAttachments"]
        invalid = [
            None, {}, [None], [source] * 20, [source, {**source, "documentId": "another-id"}], [policy, policy],
            [{**source, "documentId": policy["documentId"]}], [{**policy, "documentId": "unknown"}],
            [{**policy, "title": "different"}], [{**policy, "pages": [2]}],
            [{**source, "role": "other"}], [{**source, "mediaType": "text/html"}],
            [{**source, "pages": numbers} for numbers in ([1], list(range(2, 602)))],
            [{**source, "pages": list(range(1, 600))}, policy],
        ]
        for numbers in ([], [5, 4], [True], [0], [2, 2], [search.MAX_PAGE_NUMBER + 1]):
            invalid.append([{**source, "pages": numbers}])
        for data in ("", "not base64!", "☃", base64.b64encode(b"%PDF-1.7").decode(),
                     base64.b64encode(b"<html>").decode()):
            invalid.append([{**source, "data": data}])
        with patch.object(model, "open_provider_request") as send:
            for i, attachments in enumerate(invalid):
                with self.subTest(i=i), self.assertRaises(search.InvalidRequest):
                    api.review({**request, "pdfAttachments": attachments})
            for bad in ({"readSourcePdf": "yes"}, {"readSourcePdf": True}, {"pdfAttachments": [], "readSourcePdf": True}):
                with self.subTest(bad=bad), self.assertRaises(search.InvalidRequest):
                    api.review({**request, **bad})
            send.assert_not_called()

    def test_truncated_reordered_and_unanchored_transcriptions_fail_closed(self):
        request = payload()
        del request["questions"]
        request.update(readSourcePdf=True, pdfAttachments=[pdf_attachment("source", [5, 6])])
        rows = [{"number": 5, "text": QUESTION}, {"number": 6, "text": ""}]
        for bad in (
            {"pages": rows[:1]}, {"pages": rows[::-1]}, {"pages": [{**rows[0], "number": True}, rows[1]]},
            {"pages": [{"number": 5, "text": []}, rows[1]]},
            {"pages": rows, "incomplete": True}, {"pages": rows, "questions": ["An invented question?"]},
        ):
            with self.subTest(bad=bad), patch.object(model, "invoke_tool", return_value=bad) as invoke, \
                 self.assertRaises(model.ProviderUnavailable):
                api.review(request)
            self.assertEqual(invoke.call_count, 2 if bad.get("incomplete") else 1)

    def test_scanner_and_planner_share_deadline_and_respect_character_limits(self):
        request = payload()
        page = request["documents"][0]["pages"][0]
        page["text"] = ""
        rows = [{"number": 2, "text": RULE}]
        with patch.object(model, "invoke_tool", side_effect=[{"pages": rows}, PLAN, {"assessments": [SUPPORT]}]) as invoke:
            api.review(request)
        self.assertEqual(len({call.args[4] for call in invoke.call_args_list}), 1)
        with patch.object(pdf_reader, "MAX_CHARS", len(ANNEX)), patch.object(model, "invoke_tool", return_value={"pages": rows}), \
             self.assertRaisesRegex(search.InvalidRequest, "policy characters"):
            api.review(request)


    def test_transcription_only_bypasses_planner_and_policy_ocr_but_checks_consent_and_anchors(self):
        request = payload()
        del request["questions"]
        request.update(readSourcePdf=True, documentPart=True, transcribeSourceOnly=True)
        request["documents"][0]["pages"][0]["text"] = ""
        long_question = "How do these conditions apply " + "through review " * 180 + "after renewal?"
        questions = [f"Who files record {i}?" for i in range(40)] + [long_question]
        source_rows = [{"number": 5, "text": "\n".join(questions)}]
        for extra in ({}, {"documents": [], "pdfAttachments": request["pdfAttachments"][:1]}):
            result, calls = self.run_provider({**request, **extra}, [{"pages": source_rows, "questions": questions}])
            self.assertEqual([tool for tool, _, _ in calls], ["record_pdf_pages"])
            self.assertEqual(result["sourcePages"], source_rows)
            self.assertEqual(result["questions"], questions)
            self.assertEqual((result["engine"], result["findings"]), ("anthropic", []))
            self.assertNotIn("policyPageText", result)
        source_rows[0]["text"] = ""
        with patch.object(model, "invoke_tool", return_value={"pages": source_rows, "questions": ["Invented?"]}), \
             self.assertRaisesRegex(model.ProviderUnavailable, "matched"):
            api.review(request)
        with patch.object(model, "invoke_tool") as invoke:
            for flags in ({"modelSharingConsent": False}, {"allowModel": False}, {"readSourcePdf": False},
                          {"documentPart": False}, {"pdfAttachments": request["pdfAttachments"][1:]}):
                with self.subTest(flags=flags), self.assertRaises(search.InvalidRequest):
                    api.review({**request, **flags})
            invoke.assert_not_called()

    def test_empty_scanned_questionnaire_parts_preserve_every_page_and_skip_assessment(self):
        request = payload()
        del request["questions"]
        request.update(readSourcePdf=True, documentPart=True, pdfAttachments=[pdf_attachment("source", [2, 7])])
        rows = [{"number": 2, "text": ""}, {"number": 7, "text": "Questionnaire cover"}]
        result, calls = self.run_provider(request, [{"pages": rows, "questions": []}])
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["engine"], "anthropic")
        self.assertEqual(result["sourcePages"], rows)
        self.assertEqual([tool for tool, _, _ in calls], ["record_pdf_pages"])
        blank_rows = [{**row, "text": ""} for row in rows]
        blank, _ = self.run_provider(request, [{"pages": blank_rows}])
        self.assertEqual((blank["questions"], blank["sourcePages"]), ([], blank_rows))
        with patch.object(model, "invoke_tool", return_value={"pages": rows, "questions": []}), \
             self.assertRaisesRegex(search.InvalidRequest, "No questionnaire prompts"):
            api.review({**request, "documentPart": False})

    def test_scan_batches_validate_a_question_continued_on_the_next_page(self):
        pages = list(range(3, 3 + pdf_reader.SCAN_BATCH_PAGES + 1))
        source = pdf_attachment("source", pages)
        question = "Who signs the final report after the hearing?"
        rows = [{"number": page, "text": ""} for page in pages]
        rows[-2]["text"], rows[-1]["text"] = question.split(" after")
        rows[-1]["text"] = "after" + rows[-1]["text"]
        request = {"allowModel": True, "modelSharingConsent": True, "mode": "questionnaire", "readSourcePdf": True,
                   "documentPart": True, "transcribeSourceOnly": True, "documents": [], "pdfAttachments": [source]}
        result, calls = self.run_provider(request, [
            {"pages": rows[:-1], "questions": [question]}, {"pages": rows[-1:], "questions": []},
        ])
        self.assertEqual([data["pages"] for _, _, data in calls], [pages[:-1], pages[-1:]])
        self.assertEqual(result["sourcePages"], rows)
        self.assertEqual(result["questions"], [question])
