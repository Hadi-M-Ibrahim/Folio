import os
import unittest
from unittest.mock import patch

from api import review as api
from api._review import model
from api._review.search import InvalidRequest


def guide_input(guide, **flags):
    return {"mode": "guide", "guide": guide, "documents": [], **flags}


class GuideExtractionTests(unittest.TestCase):
    def test_background_is_optional_and_regulatory_references_keep_their_source_spans(self):
        clauses = [
            "Teams must retain inspection records.",
            "Staff must consult Sec. 4 before approving the request.",
            "The coordinator shall apply 45 C.F.R. § 164.312(a)(1) and Art. IV, para. 2.",
        ]
        source = "\n📄 Purpose\n\nThis guide was published in 2023. " + " ".join(clauses)
        result = api.review(guide_input(source))
        self.assertFalse(result["criterionLimitReached"])
        self.assertEqual([f["criterionSource"] for f in result["findings"]], clauses)
        for row in result["findings"]:
            self.assertEqual(source[row["criterionStart"]:row["criterionEnd"]], row["criterionSource"])

    def test_prohibitions_conditional_imperatives_and_required_list_fragments(self):
        duties = ["Do not discard receipts.", "Before filing, verify the\napplicant's signature.",
                  "No operator may amend the seal.", "Proof of inspection", "A dated approval letter"]
        guide = "\n".join(["Inspection dates are historical.", *duties[:3], "", "Applicants must submit:",
                           "(a) " + duties[3], "(b) " + duties[4], "", "Use of this guide is voluntary."])
        result = api.review(guide_input(guide))
        self.assertEqual([row["criterionSource"] for row in result["findings"]], duties)

    def test_only_the_final_sentence_introduces_a_required_list(self):
        guide = ("The sample indexes include Record A.....12. Examples:\n- Example form\n\n"
                 "Examples appear on page 12. Applicants must submit:\n- Signed permit")
        result = api.review(guide_input(guide))
        self.assertEqual([row["criterionSource"] for row in result["findings"]], ["Signed permit"])

    def test_background_does_not_exhaust_the_cap_and_all_context_reaches_the_planner(self):
        description = " ".join(f"This guide was revised in year {1990 + i}." for i in range(31))
        duty = "Teams must retain inspection records."
        guide = description + "\n\n" + duty
        local = api.review(guide_input(guide))
        self.assertEqual([row["criterionSource"] for row in local["findings"]], [duty])

        def inspect_guide(system, tool, data, key, deadline, max_tokens):
            self.assertEqual("".join(unit["text"] for unit in data["sources"]), guide)
            required, = [unit for unit in data["sources"] if unit["required"]]
            self.assertEqual(required["text"], duty)
            return {"criteria": [{"sourceId": required["sourceId"], "question": "Are inspection records retained?",
                                  "searchTerms": ["inspection records"]}]}

        with patch.dict(os.environ, {"VERCEL": "1", "ANTHROPIC_API_KEY": "test-key"}, clear=True), \
             patch.object(model, "invoke_tool", side_effect=inspect_guide) as invoke:
            result = api.review(guide_input(guide, allowModel=True, publicInputConsent=True))
        invoke.assert_called_once()
        self.assertEqual(result["planningEngine"], "anthropic")
        self.assertEqual(result["findings"][0]["criterionSource"], duty)

    def test_narrative_only_guide_allows_source_anchored_discovery_and_reports_planner_failure(self):
        implied = "On receipt, the clerk photographs the seal."
        guide = "The office opened in 1986. " + implied
        payload = guide_input(guide, allowModel=True, publicInputConsent=True)
        with self.assertRaisesRegex(InvalidRequest, "no explicit review criterion"):
            api.review(guide_input(guide))

        def discover(system, tool, data, key, deadline, max_tokens):
            unit, = data["sources"]
            self.assertFalse(unit["required"])
            self.assertEqual(unit["text"], guide)
            return {"criteria": [{"sourceId": unit["sourceId"], "sourceQuote": implied,
                                  "question": "Does the clerk photograph the seal on receipt?", "searchTerms": ["seal"]}]}

        with patch.dict(os.environ, {"VERCEL": "1", "ANTHROPIC_API_KEY": "test-key"}, clear=True):
            with patch.object(model, "invoke_tool", side_effect=discover):
                result = api.review(payload)
            row, = result["findings"]
            self.assertEqual(result["planningEngine"], "anthropic")
            self.assertEqual(guide[row["criterionStart"]:row["criterionEnd"]], implied)
            with patch.object(model, "invoke_tool", return_value={"criteria": []}), \
                 self.assertRaisesRegex(InvalidRequest, "No reviewable obligation"):
                api.review(payload)
            with patch.object(model, "invoke_tool", side_effect=model.ProviderUnavailable), \
                 self.assertRaisesRegex(model.ProviderUnavailable, "could not complete the search plan"):
                api.review(payload)
