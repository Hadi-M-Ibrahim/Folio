# <img src="public/folio.svg" alt="" width="40" height="40" align="absmiddle"> Folio

Folio helps compliance analysts answer state questionnaires and turn regulatory guides into a policy worklist. Start either workflow with your own documents.

## Use Folio

Open [Folio](https://folio-policy-review.vercel.app).

- **Answer a questionnaire.** Upload the questionnaire or paste the state’s questions, then add the policies to search. Open the cited page to check the suggested answer. Use a supported suggestion as a draft or write your own response. Confirm it with a citation or flag it for follow-up, then download your responses.
- **Review a new policy guide.** Upload or paste the guide. Add existing policies to check coverage, or proceed with the guide alone. Review each obligation in its original context, choose whether to write a policy, update one, or leave it unchanged, and download the action list.

Uploading a guide PDF starts its review with Anthropic. For a questionnaire, review can start once the questions and first policy are attached. The final button opens the results or joins the review already in progress. Adding a file, editing text, or changing a range cancels that version. Click the final button to review your changes. A new review starts automatically on its first eligible upload.

Keep the tab open while Folio reviews a long document. The progress bar tracks completed work, and the findings appear in document order. Use the range controls to choose questions or physical pages. A question spanning two pages includes both pages. Other questions printed on the same page remain visible in the attachment. Changing the selection cannot recall pages already sent to Anthropic.

Each section sends the corresponding PDF pages to Anthropic as a document attachment, alongside the questions, guide text, and policies used to find evidence. Short reviews can use the original file. For a narrower range or a large source, Folio builds PDFs from the visible contents of the relevant pages. Citations and exports use original page numbers. For scans, check machine-read quotations against the cited page. The form keeps your inputs and completed sections available for retry in the same tab. Source files can contain up to 1,200 pages and 32 MiB. Comparison policies accompany each section and must fit its 4 MB request budget. Download the final review before refreshing or closing it.

## Repository layout

| Directory | Contents |
| --- | --- |
| `src/components/` | Review setup, findings inspector, and source dialogs |
| `src/review/` | Frontend review types, API client, page citations, file import, and report export |
| `api/` | Python review endpoint, retrieval, and citation verification |
| `scripts/` | Private PDF preparation tool |
| `tests/` | API tests, offline fixtures, and browser tests for both workflows |
| `requirements/` | Python packages for linting, test coverage, and local PDF tools |
| `public/` | Icons and social preview artwork |

## Run locally

Use Python 3.12 and Node 22.23.5 or a newer 22.x release. Set `ANTHROPIC_API_KEY` in the Python API’s environment to run reviews. Start the API in one terminal and Vite in another.

```sh
python3 api/review.py
```

```sh
npm ci
npm run dev
```

Open the loopback URL printed by Vite. The UI proxies review requests to port 8000.

### Work with the supplied PDFs

The private materials belong in the ignored `Materials/` directory. The optional local preparation tool searches physical PDF pages and writes review bundles under the ignored `.local-review/` directory. The bundle records which pages were selected so a reviewer can see the scope of the search.

For an existing PDF environment, uninstall the old `PyMuPDF` distribution before installing `requirements/pdf.txt`. Both packages provide the `pymupdf` module.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements/pdf.txt
.venv/bin/python scripts/prepare_review.py questionnaire --questions 1-5
.venv/bin/python scripts/prepare_review.py guide --pages 11
```

In the local app, open either workflow and import the prepared review on the first step. Check the selected source and policies before submitting them for model review.

## How findings are produced

The model planner proposes atomic guide obligations anchored to verbatim source text and suggests literal search phrases, including exceptions. The Python service keeps the requirement, search terms, source page, and exact quote together through retrieval and assessment. It ranks relevant passages, reserves room for possible exceptions, and exposes term matches alongside the recommendation. Before returning a model finding, it checks quoted text against the retrieved passage and its source page. Missing or invalid citations can downgrade the finding. A verified quotation proves the words appear on that page. The analyst still judges their scope and meaning.

When a cross-reference, definition, or apparent conflict leaves a question open, the reviewer can request one more search for a literal term in a retrieved passage. Python searches the submitted policy pages and returns up to three new excerpts. The reviewer assesses them alongside the original evidence under the same citation checks and time budget. Open **Search trail** to inspect the reference, term, page hits, and new passages. An unresolved lookup stays flagged for review.

The conditional handoff adapts an idea from [Inference-Time Graph Engineering for Multi-Agent LLM Workflows](https://arxiv.org/abs/2609.05774). The shared evidence rubric and independent citation verifier draw on [Aligning AI Teams](https://arxiv.org/abs/2611.17820).

Run `python3 scripts/evaluate_followup.py` to check the synthetic cases and their scoring rules offline. With `ANTHROPIC_API_KEY` set, add `--live` to compare both reviewers using the same initial passages. The report includes missed exceptions, false contradictions, citation accuracy, token counts, and elapsed time. The cases have author-written labels and cover both workflows.

## Checks and deployment

Both workflows share a limit of 30 submissions from one IP address in 10 minutes. The Vercel Firewall rule **Folio review submissions** counts POSTs to `/api/review` and `/api/review/` per edge region. Each API worker also enforces the limit before reading documents. A limited request receives HTTP 429. A multi-part review waits for the quota to reset and then resumes. A single-request review keeps the inputs for retry. Both use the `Retry-After` header when available. [Vercel rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)

```sh
npm run lint
npm run test:unit
npm run build
npx playwright install --only-shell chromium
npm run test:e2e
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements/lint.txt -r requirements/test.txt
.venv/bin/python -m ruff check api scripts tests
.venv/bin/python -m coverage run --branch --source=api -m unittest discover -s tests -v
.venv/bin/python -m coverage report --show-missing --precision=1
```

GitHub Actions runs Oxlint, TypeScript, the Vite build, desktop and mobile browser tests, Ruff, and the Python tests on pull requests and pushes to main. The backend job summary lists uncovered API lines and branches. The main branch requires a pull request, passing frontend and backend jobs, and a successful Vercel preview. Merging deploys the revision to production. Keep the provider credential in a sensitive, server-side production environment variable.
