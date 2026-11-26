import unittest
from unittest.mock import patch

from api._review import model, planner, search


class GuidePdfLayoutTests(unittest.TestCase):
    def test_contents_entries_and_wrapped_duties_in_a_native_pdf(self):
        guide = (
            "📄 Facilities guide · Contents\n"
            "Required Documentation ........................................ 2\n"
            "Required Records ................................................... 2\n"
            "This index lists the topics covered in the following section.\n\n"
            "Inspection records\nThe site custodian photographs\nthe seal before each inspection.\n"
            "The operator must retain inspection records for thirty days.\n"
            "The inspector must re-\ncertify the register after each annual inspection."
        )
        duties = [
            "The site custodian photographs\nthe seal before each inspection.",
            "The operator must retain inspection records for thirty days.",
            "The inspector must re-\ncertify the register after each annual inspection.",
        ]
        clauses = search.guide_criteria(guide)
        self.assertEqual(clauses, [(duty, guide.index(duty)) for duty in duties[1:]])

        def respond(system, tool, data, key, deadline, **options):
            sources = data["sources"]
            self.assertEqual([item["required"] for item in sources], [False, True, True])
            self.assertIn("Required Documentation", sources[0]["text"])
            return {"criteria": [
                {"sourceId": source["sourceId"], "question": duty.rstrip(".") + "?",
                 "sourceQuote": duty.replace("-\n", "").replace("\n", " "), "searchTerms": ["inspection"]}
                for source, duty in zip(sources, duties, strict=True)
            ]}

        with patch.object(model, "invoke_tool", side_effect=respond):
            plan = planner.plan_criteria("guide", guide, clauses, "test-key", 100, document_part=True)
        self.assertEqual([(row["source"], row["start"]) for row in plan], [(duty, guide.index(duty)) for duty in duties])

    def test_repeated_exact_and_layout_equivalent_quotes_share_occurrence_order(self):
        for quote, wrapped in [("seal the register", "seal\r\n  the\u00a0register"),
                               ("recertify", "re-\ncertify"), ("re-certify", "re-\r\n  certify"),
                               ("réévaluer", "ré\u00adévaluer")]:
            with self.subTest(quote=quote):
                text = f"📕 {wrapped}. {quote}."
                unit = (text, 17, False)
                with self.assertRaises(model.ProviderUnavailable):
                    planner.guide_anchor({"sourceQuote": quote}, unit)
                for n, actual in enumerate([wrapped, quote], 1):
                    matched = planner.guide_anchor({"sourceQuote": quote, "occurrence": n}, unit)
                    self.assertEqual(matched, (actual, 17 + text.index(actual)))
                with self.assertRaises(model.ProviderUnavailable):
                    planner.guide_anchor({"sourceQuote": quote, "occurrence": 3}, unit)

    def test_layout_matching_preserves_words_case_and_meaningful_punctuation(self):
        for actual, quote in [("re-sign the form", "resign the form"), ("apply-\n\nagain", "applyagain"),
                              ("file 20-\n30 reports", "file 2030 reports"), ("Plan terms", "plan terms"),
                              ("written notice", "written notices"), ("notice, unless", "notice unless"),
                              ("the\noperator", "theoperator")]:
            with self.subTest(actual=actual, quote=quote), self.assertRaises(model.ProviderUnavailable):
                planner.guide_anchor({"sourceQuote": quote}, (actual, 0, False))

    def test_table_labels_and_dotted_form_fields_keep_independent_duties_required(self):
        duty = "The clerk must check the seal."
        guide = f"Required\n\nTimeframe\n\nRequired Documentation\n- Signed approval\n\n{duty}\n{duty}"
        required = search.guide_criteria(guide)
        self.assertEqual(required, [("Signed approval", guide.index("Signed approval")),
                                    (duty, guide.index(duty)), (duty, guide.rindex(duty))])
        for field in ["The operator must file within ...... 30", "Retain permits ...... 5"]:
            with self.subTest(field=field):
                [(clause, start)] = search.guide_criteria(field)
                self.assertEqual(start, 0)
                self.assertIn(field.partition(" ......")[0], clause)
