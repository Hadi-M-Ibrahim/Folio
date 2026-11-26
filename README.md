# <img src="public/folio.svg" alt="" width="40" height="40" align="absmiddle"> Folio

Folio helps compliance analysts answer state questionnaires and turn regulatory guides into a policy worklist. Start either workflow with your own documents.

## Use Folio

Open [Folio](https://folio-policy-review.vercel.app) or [watch the 83-second walkthrough](Deliverables/folio-walkthrough.mp4).

- **Answer a questionnaire.** Upload the questionnaire or paste the state’s questions, then add the policies to search. Open a passage to verify its page, attach the quotation to a response, and confirm or flag the answer. Download the responses with their citations.
- **Review a policy guide.** Upload or paste the guide. Add existing policies to check coverage, or proceed with the guide alone. Review each obligation in its original context, choose whether to write a policy, update one, or leave it unchanged, and download the action list.

For a long source, select a batch of questions or a range of guide pages. The workspace and export identify the selected range. Uploaded guides retain their physical page numbers.

Keyword search is the default. On the hosted site, submit only public documents. Selecting Anthropic for a review sends the questions or guide and relevant policy text to the provider using a server-side key. The app holds documents, responses, and decisions in the current tab. Download your work before refreshing or closing it.

## Repository layout

| Directory | Contents |
| --- | --- |
| `src/components/` | Review setup, findings inspector, and source dialogs |
| `src/review/` | Frontend review types, API client, page citations, file import, and report export |
| `api/` | Python review endpoint, retrieval, and citation verification |
| `scripts/` | Private PDF preparation tool |
| `tests/` | API tests, offline fixtures, and browser tests for both workflows |
| `requirements/` | Python packages for linting and optional local PDF tools |
| `public/` | Icons and social preview artwork |
| `Deliverables/` | Recorded walkthrough |

## Run locally

Use Python 3.12 and Node 22.13 or newer. Start the Python API in one terminal and Vite in another.

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

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements/pdf.txt
.venv/bin/python scripts/prepare_review.py questionnaire --questions 1-5
.venv/bin/python scripts/prepare_review.py guide --pages 11
```

In the local app, open either workflow and select **Import a prepared review (.json)** on the first step. Local keyword retrieval works without credentials. For an operator-approved model run, set `ANTHROPIC_API_KEY` in the API process environment and set `REVIEW_ALLOW_CUSTOM_MODEL=1`. The reviewer also has to select model assessment for the individual request. That sends the relevant text to Anthropic. Leave the option off for local-only processing.

## How findings are produced

The model planner proposes atomic guide obligations anchored to verbatim source text and suggests literal search phrases, including exceptions. The Python service keeps the requirement, search terms, source page, and exact quote together through retrieval and assessment. It ranks relevant passages, reserves room for possible exceptions, and exposes term matches alongside the recommendation. Before returning a model finding, it checks quoted text against the retrieved passage and its source page. Missing or invalid citations can downgrade the finding. A verified quotation proves the words appear on that page. The analyst still judges their scope and meaning.

The staged handoffs adapt an idea from [Inference-Time Graph Engineering for Multi-Agent LLM Workflows](https://arxiv.org/abs/2609.05774). The shared evidence rubric and final verification step draw on [Aligning AI Teams](https://arxiv.org/abs/2611.17820). The papers evaluated other tasks. This implementation uses a bounded workflow and makes no claim about regulatory accuracy from those results.

## Checks and deployment

```sh
npm run lint
npm run test:unit
npm run build
npx playwright install --only-shell chromium
npm run test:e2e
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements/lint.txt
.venv/bin/python -m ruff check api scripts tests
.venv/bin/python -m unittest discover -s tests -v
```

GitHub Actions runs Oxlint, TypeScript, the Vite build, desktop and mobile browser tests, Ruff, and the Python tests on pull requests and pushes to main. The main branch requires a pull request, passing frontend and backend jobs, and a successful Vercel preview. Merging deploys the revision to production. Keep the provider credential in a sensitive, server-side production environment variable. A missing or unavailable provider leaves the exact text search usable.
