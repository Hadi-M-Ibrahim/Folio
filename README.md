# <img src="public/folio.svg" alt="" width="40" height="40" align="absmiddle"> Folio

Folio helps compliance analysts answer state questionnaires and turn regulatory guides into a policy worklist. Start either workflow with your own documents.

## Use Folio

Open [Folio](https://folio-policy-review.vercel.app).

- **Answer a questionnaire.** Upload the questionnaire or paste the state’s questions, then add the policies to search. Open a passage to verify its page, attach the quotation to a response, and confirm or flag the answer. Download the responses with their citations.
- **Review a new policy guide.** Upload or paste the guide. Add existing policies to check coverage, or proceed with the guide alone. Review each obligation in its original context, choose whether to write a policy, update one, or leave it unchanged, and download the action list.

For a long source, select a batch of questions or a range of guide pages. The workspace and export identify the selected range. Uploaded guides retain their physical page numbers.

Keyword search is the default. Selecting Anthropic for a review sends the questions or guide and relevant policy text to the provider using a server-side key. The app holds documents, responses, and decisions in the current tab. Download your work before refreshing or closing it.

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

Use Python 3.12 and Node 22.23.5 or a newer 22.x release. Start the Python API in one terminal and Vite in another.

```sh
python3 api/review.py
```

```sh
npm ci
npm run dev
```

Open the loopback URL printed by Vite. The UI proxies review requests to port 8000.

### Work with the supplied PDFs

The private materials belong in the ignored `Materials/` directory. The local preparation tool searches physical PDF pages and writes review bundles under the ignored `.local-review/` directory. Pick a small batch for each review. The bundle records which pages were selected so a reviewer can see the scope of the search.

For an existing PDF environment, uninstall the old `PyMuPDF` distribution before installing `requirements/pdf.txt`. Both packages provide the `pymupdf` module.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements/pdf.txt
.venv/bin/python scripts/prepare_review.py questionnaire --questions 1-5
.venv/bin/python scripts/prepare_review.py guide --pages 11
```

In the local app, open either workflow and select **Import a prepared review (.json)** on the first step. Local keyword retrieval works without credentials. For an operator-approved model run, set `ANTHROPIC_API_KEY` in the API process environment and set `REVIEW_ALLOW_CUSTOM_MODEL=1`. The reviewer also has to select model assessment for the individual request. That sends the relevant text to Anthropic. Leave the option off for local-only processing.

## How findings are produced

The model planner proposes atomic guide obligations anchored to verbatim source text and suggests literal search phrases, including exceptions. The Python service keeps the requirement, search terms, source page, and exact quote together through retrieval and assessment. It ranks relevant passages, reserves room for possible exceptions, and exposes term matches alongside the recommendation. Before returning a model finding, it checks quoted text against the retrieved passage and its source page. Missing or invalid citations can downgrade the finding. A verified quotation proves the words appear on that page. The analyst still judges their scope and meaning.

When a cross-reference, definition, or apparent conflict leaves a question open, the reviewer can request one more search for a literal term in a retrieved passage. Python searches the submitted policy pages and returns up to three new excerpts. The reviewer assesses them alongside the original evidence under the same citation checks and time budget. Open **Search trail** to inspect the reference, term, page hits, and new passages. An unresolved lookup stays flagged for review.

The conditional handoff adapts an idea from [Inference-Time Graph Engineering for Multi-Agent LLM Workflows](https://arxiv.org/abs/2609.05774). The shared evidence rubric and independent citation verifier draw on [Aligning AI Teams](https://arxiv.org/abs/2611.17820).

Run `python3 scripts/evaluate_followup.py` to check the synthetic cases and their scoring rules offline. With `ANTHROPIC_API_KEY` set, add `--live` to compare both reviewers using the same initial passages. The report includes missed exceptions, false contradictions, citation accuracy, token counts, and elapsed time. The cases have author-written labels and cover both workflows.

## Checks and deployment

Both workflows share a limit of 30 submissions from one IP address in 10 minutes. The Vercel Firewall rule **Folio review submissions** counts POSTs to `/api/review` and `/api/review/` per edge region. Each API worker also enforces the limit before reading documents. A limited request receives HTTP 429. The form uses the `Retry-After` header when available, keeps the inputs, and allows the analyst to retry. [Vercel rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)

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

GitHub Actions runs Oxlint, TypeScript, the Vite build, desktop and mobile browser tests, Ruff, and the Python tests on pull requests and pushes to main. The backend job summary lists uncovered API lines and branches. The main branch requires a pull request, passing frontend and backend jobs, and a successful Vercel preview. Merging deploys the revision to production. Keep the provider credential in a sensitive, server-side production environment variable. A missing or unavailable provider leaves the exact text search usable.
