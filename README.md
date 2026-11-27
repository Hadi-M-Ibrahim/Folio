# <img src="public/folio.svg" alt="" width="40" height="40" align="absmiddle"> Folio

Folio compares state requirements with an organization’s existing policies. For a questionnaire, the analyst reviews a cited response to each state question. For a new regulatory guide, Folio extracts obligations so the analyst can decide which policies to keep, revise, or write. [Open Folio](https://folio-policy-review.vercel.app)

## System architecture

The React and TypeScript client splits long sources into sections and saves the files, completed sections, and analyst decisions in IndexedDB. After a refresh, it can resume from the last checkpoint. Citations open the original page, and the browser generates the final response or action-list PDF. [Sectioning and checkpoints](src/review/wholeReview.ts) · [Local storage](src/review/localReviews.ts)

A Python function on Vercel receives each section at `POST /api/review`, validates PDF page counts, and sends relevant attachments to Anthropic. It returns findings with document IDs and physical page numbers. Editing an input cancels the background review. The API checks its session before dispatching another model call. [API](api/review.py) · [PDF handling](api/_review/pdf_context.py)

## How the backend reviews a requirement

Planning, assessment, and drafting use the same model, Claude Sonnet 5.5. Batching, scan transcription, and follow-up searches determine how many calls a review needs.

1. **Plan the search.** The planner suggests literal search terms for each state question. For guides, it also proposes one question per obligation. Python preserves questionnaire wording and anchors each guide question to a quotation in the source. [Planner](api/_review/planner.py)
2. **Retrieve evidence.** Python indexes the selected policy pages and ranks passages using a BM25-style score. It keeps the top six matches plus up to two passages containing possible exceptions. The analyst can inspect the terms, page hits, and excerpts in the search trail. [Retrieval](api/_review/search.py)
3. **Assess and follow references.** The reviewer cites supporting and conflicting passages by ID and quotation. An unresolved reference, definition, or apparent conflict can trigger one more search per finding. The reviewer names a term from a retrieved passage. Python looks it up and returns up to three new excerpts for a final assessment alongside the originals. [Evidence reviewer](api/_review/model.py)
4. **Verify and decide.** Python checks each quotation against its passage and page text. A conflict also requires the reviewer to report overlap in actor, population, triggering event, and duty. Failed checks flag the finding. The analyst decides whether the evidence applies and can request an editable draft. A confirmed questionnaire response requires a citation. A proposed policy action can be saved without one. [Draft generation](api/_review/draft.py)

## Research behind the design

**Task-dependent handoffs.** Tieu et al.’s ReActNet compiles a communication graph for each task. Folio fixes the allowed steps in Python and lets the reviewer choose the lookup branch for each finding. In one test fixture, page 1 of a dispatch manual requires cotton cord and refers restoration shipments to “Schedule Cobalt.” Page 7 says those shipments travel untied. The expected finding cites both pages as mixed evidence. [Tieu et al., *Inference-Time Graph Engineering for Multi-Agent LLM Workflows* (2026)](https://arxiv.org/abs/2609.05774) · [Evaluation cases](tests/fixtures/followup_cases.json)

**Explicit responsibility for evidence.** Srinivasan et al. found that responsibility for system-wide checks can diffuse across agents. A shared specification and a designated safety lead helped in their experiments. Folio gives both assessment passes the same evidence rules and assigns the final quotation and status checks to Python. [Srinivasan et al., *Aligning AI Teams* (2026)](https://arxiv.org/abs/2611.17820)

The evaluation runs the same reviewer with follow-up enabled and disabled on seven author-labeled synthetic cases. Both runs start with identical passages. The comparison tracks missed exceptions, false contradictions, citation accuracy, token use, and latency. [Paired evaluation](scripts/evaluate_followup.py)
