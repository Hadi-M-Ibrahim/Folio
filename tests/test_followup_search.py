import unittest

from api._review.search import MAX_PASSAGE_CHARS, followup_lookup, passages


def evidence(doc_id, page, quote):
    return {"documentId": doc_id, "title": "Policy", "page": page, "quote": quote}


class FollowupSearchTests(unittest.TestCase):
    def test_reference_lookup_prefers_definition_preserving_exact_text_and_page_numbers(self):
        original = "Use the deadline under § 7.2(a)."
        pages = {("primary", 18): ("Policy", original)}
        for number in (23, 41, 52, 60):
            pages["appendix", number] = ("Policy", f"See § 7.2(a) for workflow {number}.")
        definition = "§ 7.2(a) — Deadline\r\n  \r\nThe form is due within five days."
        pages["appendix", 103] = ("Policy", definition)
        # The whitespace in the literal is flexible, and the section punctuation is literal.
        pages["appendix", 109] = ("Policy", "See §\n7.2(a). Compare § 7x2(a), § 7.2(a)bis and § 7.22(a).")

        candidates = [evidence("primary", 18, original)]
        result = followup_lookup(pages, "§ 7.2(a)", candidates)
        self.assertEqual(result, followup_lookup(pages, "§ 7.2(a)", candidates))
        self.assertEqual(result["proof"]["term"], "§ 7.2(a)")
        self.assertEqual(result["proof"]["origin"], "followup")
        self.assertEqual((result["proof"]["totalHits"], result["proof"]["totalPages"]), (7, 7))
        self.assertEqual(result["proof"]["matches"], [
            {"documentId": doc, "page": page, "count": 1} for doc, page in pages
        ])
        self.assertEqual(result["totalNewPassages"], 6)
        self.assertEqual(len(result["passages"]), 3)
        self.assertEqual(result["passages"][0], evidence("appendix", 103, definition))
        self.assertNotIn(candidates[0], result["passages"])

    def test_visible_heading_only_returns_genuinely_new_context(self):
        heading = "Exhibit M"
        rule = "The waiver applies to seasonal applications."
        pointer = "The timing is set by Exhibit M."
        pages = {("policy", 13): ("Policy", heading + "\n\n" + rule),
                 ("policy", 97): ("Policy", pointer + "\n\nAn unrelated topic.")}
        candidates = [evidence("policy", 13, heading), evidence("policy", 97, pointer)]
        result = followup_lookup(pages, heading, candidates)
        self.assertEqual(result["totalNewPassages"], 1)
        self.assertEqual(result["passages"], [evidence("policy", 13, pages["policy", 13][1])])
        result = followup_lookup(pages, heading, [*candidates, evidence("policy", 13, rule)])
        self.assertEqual((result["totalNewPassages"], result["passages"]), (0, []))
        self.assertEqual(result["proof"]["totalHits"], 2)

    def test_definitions_outrank_incidental_mentions_and_titled_sections_include_body(self):
        pages = {("doc", 3): ("Policy", "Form J2 lists contacts.\n\nJ2 is referenced below.\n\nAppend J2 after the request."),
                 ("doc", 51): ("Policy", 'For this policy "J2" means an unstaffed branch.'),
                 ("doc", 65): ("Policy", "Section J2 Eligibility\n\nBranches qualify when temporarily unstaffed.")}
        result = followup_lookup(pages, "J2", [])
        self.assertEqual(result["totalNewPassages"], 5)
        self.assertEqual([p["page"] for p in result["passages"]], [51, 65, 3])
        self.assertEqual(result["passages"][1]["quote"], pages["doc", 65][1])

    def test_duplicate_page_excerpts_count_once_and_proof_totals_survive_display_cap(self):
        piece = "See form RBC or rbc."
        body = f"{piece}\n\n{piece}\n\nSee RBCs and preRBC."
        pages = {("doc", p): ("Policy", body) for p in range(2, 56, 2)}
        candidates = [evidence("doc", 2, piece)]
        result = followup_lookup(pages, "RBC", candidates)
        proof = result["proof"]
        self.assertEqual((proof["totalHits"], proof["totalPages"]), (108, 27))
        self.assertEqual(len(proof["matches"]), 24)
        self.assertEqual(proof["matches"][0], {"documentId": "doc", "page": 2, "count": 4})
        self.assertEqual(result["totalNewPassages"], 26)
        self.assertEqual(result["passages"], [evidence("doc", p, piece) for p in (4, 6, 8)])

    def test_long_page_keeps_match_crossing_passage_boundary_verbatim(self):
        body = "a" * (MAX_PASSAGE_CHARS - 5) + " RED FLAG applies to a provisional permit."
        self.assertFalse(any("RED FLAG" in piece for piece in passages(body)))
        result = followup_lookup({("doc", 11): ("Policy", body)}, "red flag", [])
        quote = result["passages"][0]["quote"]
        self.assertIn("RED FLAG applies to a provisional permit.", quote)
        self.assertIn(quote, body)
        self.assertLessEqual(len(quote), MAX_PASSAGE_CHARS)
        self.assertEqual((result["proof"]["totalHits"], result["totalNewPassages"]), (1, 1))

    def test_no_matches_and_a_match_too_widely_spaced_for_an_excerpt(self):
        pages = {("doc", 1): ("Policy", "RED\n" + " " * MAX_PASSAGE_CHARS + "\nFLAG")}
        for term, hits in (("RED FLAG", 1), ("S.3*", 0)):
            with self.subTest(term=term):
                result = followup_lookup(pages, term, [])
                self.assertEqual((result["totalNewPassages"], result["passages"]), (0, []))
                self.assertEqual(result["proof"]["totalHits"], hits)
