# <img src="public/folio.svg" alt="" width="40" height="40" align="absmiddle"> Folio

Folio helps a compliance analyst answer a state questionnaire or turn a new policy guide into a list of requirements to review. Each finding links back to the policy language on a specific page. The analyst can inspect supporting and conflicting passages, open the literal search results, and record a decision. The review log can export the findings and citations as Markdown.

## Try it

[Watch the 77-second walkthrough](Deliverables/folio-walkthrough.mp4).

Open the sample case on [Folio](https://folio-policy-review.vercel.app). Select the first grievance question and compare the general acknowledgment policy with the telephone exception. Open the source pages to decide whether the two instructions apply to the same members. Start a new review to run either the questionnaire or the regulatory guide through the Python service.

The public sample and its policies are fictional. The opening case is a prepared example. The results of a new review identify whether Anthropic or keyword retrieval produced them. The public service accepts custom public text for keyword search. Only the bundled fictional inputs qualify for hosted model calls.

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
.venv/bin/python -m pip install -r scripts/requirements.txt
.venv/bin/python scripts/prepare_review.py questionnaire --questions 1-5
.venv/bin/python scripts/prepare_review.py guide --pages 11
```

In the local app, start a new review, choose custom input, and import the generated JSON. Local keyword retrieval works without credentials. For an operator-approved model run, set `ANTHROPIC_API_KEY` in the API process environment and set `REVIEW_ALLOW_CUSTOM_MODEL=1`. The reviewer also has to select model assessment for the individual request. That sends the relevant text to Anthropic. Leave the option off for local-only processing.

## How findings are produced

The model planner proposes atomic guide obligations anchored to verbatim source text and suggests literal search phrases, including exceptions. The Python service keeps the requirement, search terms, source page, and exact quote together through retrieval and assessment. It ranks relevant passages, reserves room for possible exceptions, and exposes term matches alongside the recommendation. Before returning a model finding, it checks quoted text against the retrieved passage and its source page. Missing or invalid citations can downgrade the finding. A verified quotation proves the words appear on that page. The analyst still judges their scope and meaning.

The staged handoffs adapt an idea from [Inference-Time Graph Engineering for Multi-Agent LLM Workflows](https://arxiv.org/abs/2609.05774). The shared evidence rubric and final verification step draw on [Aligning AI Teams](https://arxiv.org/abs/2611.17820). The papers evaluated other tasks. This implementation uses a bounded workflow and makes no claim about regulatory accuracy from those results.

## Checks and deployment

```sh
npm run build
python3 -m unittest discover -s tests -p 'test_review*.py' -v
```

With the server-side provider key configured, `python3 scripts/evaluate_sample.py` runs a live evaluation of the five fictional requirements in both modes. It compares outcomes with the authored rubric and exits unsuccessfully on a discrepancy. This consumes provider credits and can vary between runs. The offline CI suite uses controlled provider responses.

GitHub Actions builds the frontend and runs the Python checks on pull requests and pushes to main. The main branch requires a pull request, passing frontend and backend jobs, and a successful Vercel preview. Merging deploys the revision to production. Keep the provider credential in a sensitive, server-side production environment variable. A missing or unavailable provider leaves the exact text search usable.
