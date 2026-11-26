"""Deterministic criterion extraction, passage ranking, and exact word-count evidence."""

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from heapq import nsmallest

MAX_CRITERIA = 30
MAX_DOCUMENTS = 18
MAX_GUIDE_CHARS = 50_000
MAX_QUESTION_CHARS = 2_000
MAX_PAGE_CHARS = 35_000
MAX_PASSAGE_CHARS = 680
MAX_PAGES = 1200
MAX_CHARS = 2_400_000
# The browser must be able to distinguish every citation's page number exactly.
MAX_PAGE_NUMBER = (1 << 53) - 1

WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)?", re.UNICODE)
STOP = set("""
a an the does do did are were was have has had must should shall can could may will would be been is
of as at to for that which when all each every on in within and or by with from its it their this
those these any whether what how why if plan plans organization organizations provide provides
require requires required include includes ensure ensures confirm verify identify determine review
the following under than then during regarding about into through related applicable relevant
""".split())
# Related forms expand the shortlist. Search proof still counts each literal term separately.
FAMILIES = (
    "acknowledge acknowledges acknowledged acknowledgment acknowledgments acknowledgement acknowledgements",
    "member members member’s member's enrollee enrollees beneficiary beneficiaries",
    "grievance grievances complaint complaints",
    "write writes writing written",
    "request requests requested",
    "record records recorded document documents documented capture captures",
    "send sends sent sending issue issues issued distribute distributes",
    "notify notifies notification notifications notice notices",
    "language languages",
    "prefer preferred preference preferences",
    "deadline deadlines timeframe timeframes timelines",
    "escalate escalates escalated escalation referrals referral",
    "urgent urgency expedited",
    "supervisor supervisors supervisory",
    "day days",
    "close closes closed closing closure",
    "receipt received",
    "cover covers covered coverage",
    "authorize authorization authorizations approve approves approved approval",
    "appeal appeals",
    "deny denies denial denials denied",
    "drug drugs medication medications",
    "annual annually yearly",
    "five 5", "ten 10", "thirty 30", "fifteen 15",
)
FAMILY = {word: group.split()[0] for group in FAMILIES for word in group.split()}
ADVERSE = re.compile(r"\b(?:no|not|only|except(?:ion)?|exclude[ds]?|unless|instead|next|waiv\w*|verbal|restrict\w*|later|delay\w*)\b", re.I)
OBLIGATION = re.compile(
    r"\b(?:must|shall|should|cannot|may (?:not|only)|no (?:\w+\s+){1,4}(?:may|can)|(?:has|have|needs?|ought) to|"
    r"requir(?:es?|ed)|prohibit(?:s|ed)|forbid(?:s|den)|obligat(?:ed|ory)|mandatory|responsible for|"
    r"(?:not|never) (?:allowed|permitted)|(?:is|are) (?:permitted|allowed) only)\b", re.I,
)
IMPERATIVE = re.compile(
    r"^(?:(?:if|when|before|after|upon|unless|for)\b[^,]{1,300},\s*)?"
    r"(?:please\s+)?(?:do not|never|ensure|verify|confirm|determine|check|assess|evaluate|review|"
    r"retain|record|submit|notify|report|maintain|document|keep|file|provide|include|obtain|send|"
    r"publish|consult|identify|inspect|sign|approve|complete|establish|implement|issue|monitor|"
    r"deliver|update|disclose|collect|use|follow|attach|prohibit|prevent|allow)\s+(?!of\b|was\b|is\b)\S", re.I,
)
LIST_MARK = r"(?:[-*•]|\(\d{1,3}\)|\d{1,3}[.)]|\([a-z]\)|[a-z][.)])"
BULLET = re.compile(r"^\s*" + LIST_MARK + r"\s+", re.I)
GUIDE_BLOCK = re.compile(r"\n\s*\n|\n(?=[^\S\n]*" + LIST_MARK + r"\s+)", re.I)
LIST_LEAD = re.compile(r"\b(?:must|shall|include|provide|required|requirements|checklist|submit)\b", re.I)
LIST_HEADING = re.compile(
    r"(?:(?:(?:application|filing|inspection|minimum|policy|reporting|submission|training) )?"
    r"(?:requirements|checklist)|required (?:documents|attachments|records))", re.I,
)
SENTENCE_END = re.compile(r"""(?<![.!?])[.!?]+["'’”)]*(?=\s|$)""")
REFERENCE_ABBREVIATION = re.compile(
    r"\b(?:secs?|subsecs?|arts?|chs?|paras?|pars?|pts?|nos?|regs?|figs?|vols?|pp?|dept|"
    r"e\.g|i\.e|cf|vs|(?:[a-z]\.)+[a-z])\.$", re.I,
)
REFERENCE_PREFIXES = {"", "§", "§§", "section", "sec.", "article", "appendix", "exhibit", "schedule", "part", "chapter"}
DEFINITION = re.compile(r"""^["'”’]?\s*(?:means\b|refers to\b|is defined as\b|[:—–])""", re.I)


class InvalidRequest(ValueError):
    pass


def bounded_string(value, label, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise InvalidRequest(f"{label} must be nonempty text of at most {limit:,} characters.")
    return value.strip()


def guide_sentences(body):
    """Yield original spans, keeping dotted legal references and internal line wrapping."""
    start = 0
    for end in SENTENCE_END.finditer(body):
        if end.group() == "." and REFERENCE_ABBREVIATION.search(body[max(start, end.end() - 32):end.end()]):
            continue
        yield body[start:end.end()], start
        start = end.end()
    if start < len(body):
        yield body[start:], start


def is_list_lead(body):
    if not body.rstrip().endswith(":"):
        return False
    start = max(body.rfind(mark) for mark in ".!?") + 1
    return LIST_LEAD.search(body, start) is not None


def guide_criteria(guide):
    chosen = []
    has_narrative = False
    checklist = False
    position = 0
    for block in GUIDE_BLOCK.split(guide):
        start = guide.find(block, position)
        position = start + len(block)
        body = BULLET.sub("", block, count=1)
        body_start = start + len(block) - len(body)
        listed = body != block
        if not listed:
            checklist = bool(LIST_HEADING.fullmatch(block.strip())) or is_list_lead(block)
        for raw, sentence_start in guide_sentences(body):
            clause = raw.strip()
            if not WORD.search(clause):
                continue
            has_narrative |= len(WORD.findall(clause)) >= 3
            # A list introducer supplies context to the items that follow it.
            if LIST_HEADING.fullmatch(clause) or is_list_lead(clause):
                continue
            if (OBLIGATION.search(clause) or IMPERATIVE.match(clause) or clause.endswith("?")
                    or (listed and checklist and sentence_start == 0)):
                offset = body_start + sentence_start + len(raw) - len(raw.lstrip())
                chosen.append((clause, offset))
    if not chosen and not has_narrative:
        raise InvalidRequest("The guide needs a sentence or list item describing a review criterion.")
    if len(chosen) > MAX_CRITERIA:
        raise InvalidRequest(f"This guide has {len(chosen)} explicit criteria. Submit at most {MAX_CRITERIA} per review.")
    return chosen


def validate(payload):
    if not isinstance(payload, dict) or payload.get("mode") not in ("questionnaire", "guide"):
        raise InvalidRequest("Choose questionnaire or guide mode.")
    for consent in ("allowModel", "modelSharingConsent", "publicInputConsent"):
        if type(payload.get(consent, False)) is not bool:
            raise InvalidRequest(f"{consent} must be true or false.")
    mode = payload["mode"]
    if mode == "guide":
        guide = bounded_string(payload.get("guide"), "Guide", MAX_GUIDE_CHARS)
        # Offsets address the input string including any leading whitespace.
        shift = len(payload["guide"]) - len(payload["guide"].lstrip())
        criteria = [(q, shift + pos) for q, pos in guide_criteria(guide)]
    else:
        questions = payload.get("questions")
        if not isinstance(questions, list) or not 1 <= len(questions) <= MAX_CRITERIA:
            raise InvalidRequest(f"Provide 1 to {MAX_CRITERIA} questions.")
        criteria = [(bounded_string(q, "Each question", MAX_QUESTION_CHARS), None) for q in questions]
    return mode, criteria, document_pages(payload.get("documents"), mode)


def validated_documents(docs, mode):
    if not isinstance(docs, list) or len(docs) > MAX_DOCUMENTS:
        raise InvalidRequest(f"Provide a list of up to {MAX_DOCUMENTS} policy documents.")
    if not docs and mode == "questionnaire":
        raise InvalidRequest("Provide at least one policy document with the questionnaire.")
    identifiers = set()
    for doc in docs:
        if not isinstance(doc, dict):
            raise InvalidRequest("Each document needs an id, title, and pages.")
        doc_id = bounded_string(doc.get("id"), "Document ID", 100)
        title = bounded_string(doc.get("title"), "Document title", 240)
        if doc_id in identifiers or doc_id != doc["id"]:
            raise InvalidRequest("Each document needs a unique ID without surrounding whitespace.")
        identifiers.add(doc_id)
        if not isinstance(doc.get("pages"), list) or not doc["pages"]:
            raise InvalidRequest("Each document needs one or more pages.")
        yield doc_id, title, doc["pages"]


def document_pages(docs, mode):
    pages = {}
    size = 0
    for doc_id, title, source_pages in validated_documents(docs, mode):
        has_text = False
        for page in source_pages:
            if (not isinstance(page, dict) or type(page.get("number")) is not int
                    or not 1 <= page["number"] <= MAX_PAGE_NUMBER):
                raise InvalidRequest(f"Each page needs an integer page number from 1 to {MAX_PAGE_NUMBER:,}.")
            key = (doc_id, page["number"])
            if key in pages:
                raise InvalidRequest("Page numbers must be unique within a document.")
            body = page.get("text")
            if not isinstance(body, str) or len(body) > MAX_PAGE_CHARS:
                raise InvalidRequest(f"Each page must contain text of at most {MAX_PAGE_CHARS:,} characters.")
            size += len(body)
            if size > MAX_CHARS or len(pages) >= MAX_PAGES:
                raise InvalidRequest(f"Submit at most {MAX_PAGES:,} pages and {MAX_CHARS:,} source characters per review.")
            has_text = has_text or bool(body.strip())
            pages[key] = (title, body)
        if not has_text:
            raise InvalidRequest(f"{title} contains no searchable text.")
    return pages


def words(text):
    return (m.group().casefold() for m in WORD.finditer(text))


def group_for(word):
    return FAMILY.get(word, word)


def passages(page):
    # Exact slices keep punctuation, PDF spacing, and line breaks for citation validation.
    for para in re.split(r"\n\s*\n", page):
        remaining = para.strip()
        while remaining:
            if len(remaining) <= MAX_PASSAGE_CHARS:
                yield remaining
                break
            end = max(remaining.rfind(mark, 220, MAX_PASSAGE_CHARS) for mark in (". ", "! ", "? ", "\n"))
            if end == -1:
                end = remaining.rfind(" ", 220, MAX_PASSAGE_CHARS)
            if end == -1:
                end = MAX_PASSAGE_CHARS - 1
            yield remaining[:end + 1].strip()
            remaining = remaining[end + 1:].strip()


@dataclass
class Passage:
    evidence: dict
    counts: Counter
    length: int
    adverse: bool


def basic_plan(criteria):
    return [{"question": q, "source": q, "start": pos, "searchTerms": []} for q, pos in criteria]


def criterion_fields(row, number):
    start = row["start"]
    return {
        "id": f"q{number}", "question": row["question"], "criterionSource": row["source"],
        "criterionStart": start, "criterionEnd": start + len(row["source"]) if start is not None else None,
    }


def normalize_term(text):
    return " ".join(text.casefold().split())


def phrase_pattern(term):
    return re.compile(r"(?<!\w)" + r"\s+".join(re.escape(part) for part in term.split()) + r"(?!\w)", re.I)


def phrase_hits(text, patterns):
    for phrase, pattern in patterns.items():
        count = sum(1 for _ in pattern.finditer(text))
        if count:
            yield phrase, count


def term_proof(term, origin, hits):
    matches = [{"documentId": d, "page": p, "count": n} for (d, p), n in hits.most_common(24)]
    return {"term": term, "origin": origin, "matches": matches, "totalPages": len(hits), "totalHits": sum(hits.values())}


def literal_matches(term):
    """Use the same token and phrase semantics as the initial search proof."""
    if WORD.fullmatch(term):
        folded = term.casefold()
        return lambda body: (hit for hit in WORD.finditer(body) if hit[0].casefold() == folded)
    return phrase_pattern(term).finditer


def passage_spans(body):
    cursor = 0
    for piece in passages(body):
        start = body.index(piece, cursor)
        cursor = start + len(piece)
        yield start, cursor


def heading_with_context(body, spans, index, visible):
    """Join a matching heading to previously unseen text using the exact PDF whitespace."""
    start, end = spans[index]
    next_start, next_end = spans[index + 1]
    context = body[next_start:min(next_end, start + MAX_PASSAGE_CHARS)].rstrip()
    if WORD.search(context) and context != body[start:end] and not any(context in quote for quote in visible):
        return body[start:next_start + len(context)]
    return None


def heading_suffix(tail):
    if not tail.strip(".:—–-\"'”’"):
        return True
    if len(tail) > 80 or "\n" in tail or tail.endswith((".", "!", "?")):
        return False
    return tail.startswith(("—", "–", "-", ":", ". ")) or tail[0].isupper()


def followup_excerpt(body, spans, index, hit, visible):
    start, end = spans[index]
    piece = body[start:end]
    prefix = body[start:hit.start()].strip(" \t\r\n\"'“‘").casefold()
    tail = body[hit.end():end].strip()
    if prefix in REFERENCE_PREFIXES and heading_suffix(tail) and hit.end() <= end and index + 1 < len(spans):
        joined = heading_with_context(body, spans, index, visible)
        if joined:
            return 0, joined
    if piece in visible or hit.end() - hit.start() > MAX_PASSAGE_CHARS:
        return None
    if hit.end() > end:
        # The literal itself can straddle a paragraph or a fixed-length excerpt boundary.
        start = max(start, hit.start() - 80, hit.end() - MAX_PASSAGE_CHARS)
        end = min(len(body), start + MAX_PASSAGE_CHARS)
    quote = body[start:end].strip()
    if any(quote in old for old in visible):
        return None
    if DEFINITION.match(tail):
        return 0, quote
    return (1 if prefix in REFERENCE_PREFIXES else 2), quote


def followup_page(body, hits, visible):
    spans = list(passage_spans(body))
    ranked = {}
    hit_index = 0
    for index, (_, end) in enumerate(spans):
        hit = hits[hit_index]
        if hit.start() >= end:
            continue
        excerpt = followup_excerpt(body, spans, index, hit, visible)
        if excerpt:
            rank, quote = excerpt
            ranked[quote] = min(rank, ranked.get(quote, rank))
        while hit_index < len(hits) and hits[hit_index].start() < end:
            hit_index += 1
        if hit_index == len(hits):
            break
    return ranked


def followup_lookup(pages, term, candidates):
    """Count all literal hits and return up to three new, directly matching source slices."""
    visible = defaultdict(set)
    for candidate in candidates:
        visible[candidate["documentId"], candidate["page"]].add(candidate["quote"])
    counts = Counter()
    shortlist = []
    total = 0
    term = term.strip()
    if term:
        find_matches = literal_matches(term)
        for key, (title, body) in pages.items():
            hits = list(find_matches(body))
            if not hits:
                continue
            counts[key] = len(hits)
            ranked = followup_page(body, hits, visible.get(key, ()))
            total += len(ranked)
            for quote in nsmallest(3, ranked, key=ranked.get):
                evidence = {"documentId": key[0], "title": title, "page": key[1], "quote": quote}
                shortlist.append((ranked[quote], evidence))
    return {
        "proof": term_proof(term, "followup", counts),
        "passages": [evidence for _, evidence in nsmallest(3, shortlist, key=lambda item: item[0])],
        "totalNewPassages": total,
    }


class Index:
    def __init__(self, pages, plan):
        self.items = []
        self.postings = defaultdict(list)
        self.page_hits = defaultdict(Counter)
        self.forms = defaultdict(set)
        model_terms = {normalize_term(t) for row in plan for t in row["searchTerms"]}
        self.phrases = {term: phrase_pattern(term) for term in model_terms if not WORD.fullmatch(term)}
        interest = {group_for(w) for row in plan for w in words(row["question"]) if w not in STOP}
        interest.update(group_for(t) for t in model_terms if t not in self.phrases)
        total_words = 0
        self.passage_count = 0
        for page_key, (title, body) in pages.items():
            doc_id, number = page_key
            page_phrases = self.index_page_terms(page_key, body, interest)
            for piece in passages(body):
                literal = Counter(words(piece))
                length = sum(literal.values())
                if not length:
                    continue
                total_words += length
                self.passage_count += 1
                if self.passage_count > 50000:
                    raise InvalidRequest("The documents contain more than 50,000 passages. Split the review into smaller batches.")
                counts = Counter()
                for word, count in literal.items():
                    group = group_for(word)
                    if group in interest:
                        counts[group] += count
                for phrase, count in phrase_hits(piece, page_phrases):
                    counts[phrase] = count
                if not counts:
                    continue
                index = len(self.items)
                for group in counts:
                    self.postings[group].append(index)
                self.items.append(Passage(
                    {"documentId": doc_id, "title": title, "page": number, "quote": piece},
                    counts, length, bool(ADVERSE.search(piece)),
                ))
        self.mean_length = total_words / max(1, self.passage_count)

    def index_page_terms(self, page_key, body, interest):
        for word, count in Counter(words(body)).items():
            group = group_for(word)
            if group in interest:
                self.page_hits[word][page_key] = count
                self.forms[group].add(word)
        page_phrases = {}
        for phrase, count in phrase_hits(body, self.phrases):
            self.page_hits[phrase][page_key] = count
            page_phrases[phrase] = self.phrases[phrase]
        return page_phrases

    def rank_candidates(self, groups):
        scores = Counter()
        for group in groups:
            posting = self.postings.get(group, ())
            idf = math.log1p((self.passage_count - len(posting) + .5) / (len(posting) + .5))
            weight = 2.0 if group in self.phrases else 1.0
            for index in posting:
                item = self.items[index]
                freq = item.counts[group]
                scores[index] += weight * idf * freq * 2.2 / (freq + 1.2 * (.25 + .75 * item.length / self.mean_length))

        def rank(index):
            return -scores[index], index

        # Retain two high-ranked passages with potential exceptions alongside the main shortlist.
        shortlist = nsmallest(6, scores, key=rank)
        adverse = nsmallest(2, (i for i in scores if self.items[i].adverse), key=rank)
        selected = sorted(set(shortlist).union(adverse), key=rank)
        return [self.items[i].evidence for i in selected], len(scores)

    def retrieve(self, row, number):
        origins = dict.fromkeys((normalize_term(t) for t in row["searchTerms"]), "model")
        model_terms = list(origins)
        for term in words(row["question"]):
            if term not in STOP:
                origins.setdefault(term, "criterion")
        groups = dict.fromkeys(group_for(term) for term in origins)
        candidates, candidate_count = self.rank_candidates(groups)
        for group in groups:
            for form in sorted(self.forms.get(group, ())):
                origins.setdefault(form, "related_form")
        # Bound the visible search log for large inventories and report all omissions.
        visible_terms = list(origins)[:24]
        proof = [term_proof(term, origins[term], self.page_hits[term]) for term in visible_terms]
        return {
            **criterion_fields(row, number),
            "status": "needs_review" if candidates else "insufficient",
            "answer": ("Review the ranked passages to decide whether they address this criterion."
                       if candidates else "The search terms returned no source passages. Evidence is insufficient for a decision."),
            "supporting": [], "counter": [], "searchTerms": visible_terms, "plannedTerms": model_terms,
            "searchProof": proof, "totalSearchTerms": len(origins),
            "candidates": candidates, "totalCandidatePassages": candidate_count, "analysisEngine": "local",
        }


def retrieve(pages, plan):
    if not pages:
        return [{
            **criterion_fields(row, number),
            "status": "needs_review", "answer": "No existing policies were supplied for comparison.",
            "supporting": [], "counter": [], "candidates": [], "totalCandidatePassages": 0,
            "plannedTerms": row["searchTerms"], "searchTerms": [], "searchProof": [], "totalSearchTerms": 0,
            "analysisEngine": "local",
        } for number, row in enumerate(plan, 1)]
    index = Index(pages, plan)
    return [index.retrieve(row, i) for i, row in enumerate(plan, 1)]
