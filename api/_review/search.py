"""Deterministic criterion extraction, passage ranking, and exact word-count evidence."""

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass

MAX_CRITERIA = 30
MAX_PAGES = 1200
MAX_CHARS = 2_400_000

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
LIST_LEAD = re.compile(r"\b(?:must|shall|include|provide|required|requirements|checklist|submit)\b[^.!?]*:\s*$", re.I)
LIST_HEADING = re.compile(
    r"(?:(?:(?:application|filing|inspection|minimum|policy|reporting|submission|training) )?"
    r"(?:requirements|checklist)|required (?:documents|attachments|records))", re.I,
)
SENTENCE_END = re.compile(r"""[.!?]+["'’”)]*(?=\s|$)""")
REFERENCE_ABBREVIATION = re.compile(
    r"\b(?:secs?|subsecs?|arts?|chs?|paras?|pars?|pts?|nos?|regs?|figs?|vols?|pp?|dept|"
    r"e\.g|i\.e|cf|vs|(?:[a-z]\.)+[a-z])\.$", re.I,
)


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
            checklist = bool(LIST_HEADING.fullmatch(block.strip())) or (
                block.rstrip().endswith(":") and bool(LIST_LEAD.search(block))
            )
        for raw, sentence_start in guide_sentences(body):
            clause = raw.strip()
            if not WORD.search(clause):
                continue
            has_narrative |= len(WORD.findall(clause)) >= 3
            # A list introducer supplies context to the items that follow it.
            if LIST_HEADING.fullmatch(clause) or (clause.endswith(":") and LIST_LEAD.search(clause)):
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
    for consent in ("allowModel", "publicInputConsent"):
        if type(payload.get(consent, False)) is not bool:
            raise InvalidRequest(f"{consent} must be true or false.")
    mode = payload["mode"]
    if mode == "guide":
        guide = bounded_string(payload.get("guide"), "Guide", 50000)
        # Offsets address the input string including any leading whitespace.
        shift = len(payload["guide"]) - len(payload["guide"].lstrip())
        criteria = [(q, shift + pos) for q, pos in guide_criteria(guide)]
    else:
        questions = payload.get("questions")
        if not isinstance(questions, list) or not 1 <= len(questions) <= MAX_CRITERIA:
            raise InvalidRequest(f"Provide 1 to {MAX_CRITERIA} questions.")
        criteria = [(bounded_string(q, "Each question", 2000), None) for q in questions]
    docs = payload.get("documents")
    if not isinstance(docs, list) or len(docs) > 18:
        raise InvalidRequest("Provide a list of up to 18 policy documents.")
    if not docs and mode == "questionnaire":
        raise InvalidRequest("Provide at least one policy document with the questionnaire.")
    identifiers = set()
    pages = {}
    size = 0
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
        has_text = False
        for page in doc["pages"]:
            if not isinstance(page, dict) or type(page.get("number")) is not int or page["number"] < 1:
                raise InvalidRequest("Each page needs a positive integer page number.")
            key = (doc_id, page["number"])
            if key in pages:
                raise InvalidRequest("Page numbers must be unique within a document.")
            body = page.get("text")
            if not isinstance(body, str) or len(body) > 35000:
                raise InvalidRequest("Each page must contain text of at most 35,000 characters.")
            size += len(body)
            if size > MAX_CHARS or len(pages) >= MAX_PAGES:
                raise InvalidRequest("Submit at most 1,200 pages and 2,400,000 source characters per review.")
            has_text = has_text or bool(body.strip())
            pages[key] = (title, body)
        if not has_text:
            raise InvalidRequest(f"{title} contains no searchable text.")
    return mode, criteria, pages


def words(text):
    return (m.group().casefold() for m in WORD.finditer(text))


def group_for(word):
    return FAMILY.get(word, word)


def passages(page):
    # Exact slices keep punctuation, PDF spacing, and line breaks for citation validation.
    for para in re.split(r"\n\s*\n", page):
        remaining = para.strip()
        while remaining:
            if len(remaining) <= 680:
                yield remaining
                break
            end = max(remaining.rfind(mark, 220, 680) for mark in (". ", "! ", "? ", "\n"))
            if end == -1:
                end = remaining.rfind(" ", 220, 680)
            if end == -1:
                end = 679
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
        for (doc_id, number), (title, body) in pages.items():
            page_key = (doc_id, number)
            for word, count in Counter(words(body)).items():
                group = group_for(word)
                if group in interest:
                    self.page_hits[word][page_key] = count
                    self.forms[group].add(word)
            page_phrases = {}
            for phrase, pattern in self.phrases.items():
                hits = sum(1 for _ in pattern.finditer(body))
                if hits:
                    self.page_hits[phrase][page_key] = hits
                    page_phrases[phrase] = pattern
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
                for phrase, pattern in page_phrases.items():
                    occurrences = sum(1 for _ in pattern.finditer(piece))
                    if occurrences:
                        counts[phrase] = occurrences
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

    def retrieve(self, row, number):
        question = row["question"]
        model_terms = list(dict.fromkeys(normalize_term(t) for t in row["searchTerms"]))
        terms = list(dict.fromkeys(w for w in words(question) if w not in STOP))
        groups = list(dict.fromkeys(group_for(w) for w in model_terms + terms))
        scores = Counter()
        for group in groups:
            posting = self.postings[group]
            idf = math.log1p((self.passage_count - len(posting) + .5) / (len(posting) + .5))
            weight = 2.0 if group in self.phrases else 1.0
            for index in posting:
                item = self.items[index]
                freq = item.counts[group]
                scores[index] += weight * idf * freq * 2.2 / (freq + 1.2 * (.25 + .75 * item.length / self.mean_length))
        ranked = sorted(scores, key=lambda i: (-scores[i], i))
        # Retain two high-ranked passages with potential exceptions alongside the main shortlist.
        selected = set(ranked[:6]) | set([i for i in ranked if self.items[i].adverse][:2])
        candidates = [self.items[i].evidence for i in ranked if i in selected]

        literal_terms = list(dict.fromkeys(model_terms + terms))
        for group in groups:
            literal_terms.extend(sorted(self.forms[group] - set(literal_terms)))
        # Bound the visible search log for large inventories and report all omissions.
        proof = []
        for term in literal_terms[:24]:
            hits = self.page_hits[term]
            matches = [{"documentId": d, "page": p, "count": n} for (d, p), n in hits.most_common(24)]
            origin = "model" if term in model_terms else ("criterion" if term in terms else "related_form")
            proof.append({"term": term, "origin": origin, "matches": matches, "totalPages": len(hits), "totalHits": sum(hits.values())})
        return {
            **criterion_fields(row, number),
            "status": "needs_review" if candidates else "insufficient",
            "answer": ("Review the ranked passages to decide whether they address this criterion."
                       if candidates else "The search terms returned no source passages. Evidence is insufficient for a decision."),
            "supporting": [], "counter": [], "searchTerms": literal_terms[:24], "plannedTerms": model_terms,
            "searchProof": proof, "totalSearchTerms": len(literal_terms),
            "candidates": candidates, "totalCandidatePassages": len(ranked), "analysisEngine": "local",
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
