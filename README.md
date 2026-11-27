# <img src="public/folio.svg" alt="" width="40" height="40" align="absmiddle"> Folio

Folio compares state requirements with existing policies. An analyst can answer a questionnaire with citations or use a new guide to decide which policies to keep, change, or write. [Open Folio](https://folio-policy-review.vercel.app)

## Architecture

The React client uses TypeScript and sends long documents in sections. IndexedDB keeps files, progress, and decisions so the analyst can continue after a page reload. The client exports responses or policy actions to PDF. [Review sections](src/review/wholeReview.ts) · [Local storage](src/review/localReviews.ts)

A Python function on Vercel receives each section at `POST /api/review`. It compares PDF page counts with the client’s counts before it sends pages to Anthropic. If the analyst changes an input, Folio cancels the review. [Review API](api/review.py)

## Evidence review

1. **Questions.** Claude Sonnet 5.5 selects search terms. Folio keeps the wording of each state question. For a guide, the model gives one question and one source quotation per obligation. [Planner](api/_review/planner.py)
2. **Search.** Python uses a BM25 score to select up to six passages. It includes up to two more for possible exceptions. The search trail shows terms, passages, and page numbers. [Policy search](api/_review/search.py)
3. **Assessment.** The model cites passages that support or contradict a requirement. To follow a reference, the model selects a term from a passage. Python finds up to three more passages. [Evidence review](api/_review/model.py)
4. **Checks.** Python compares each quotation with its passage and source page. For a conflict, the model must show overlap in parties, populations, events, and duties. If a check fails, Folio marks the finding for review.

The analyst can open the source page and change the draft. Citations are mandatory for confirmed responses and optional for policy actions. [Drafts](api/_review/draft.py)

## Research and evaluation

Tieu and colleagues adapt the workflow to each task. Folio uses fixed steps but lets the model select one more search per finding. [Inference-Time Graph Engineering for Multi-Agent LLM Workflows](https://arxiv.org/abs/2609.05774)

Srinivasan and colleagues assign safety checks to one agent. Folio gives each assessment the same evidence rules. Python does the citation and status checks. [Aligning AI Teams](https://arxiv.org/abs/2611.17820)

The evaluation compares reviews with and without the second search on seven synthetic cases. Each pair starts with the same passages. The evaluation records missed exceptions, incorrect reports of conflict, citation accuracy, token counts, and time. [Evaluation](scripts/evaluate_followup.py)
