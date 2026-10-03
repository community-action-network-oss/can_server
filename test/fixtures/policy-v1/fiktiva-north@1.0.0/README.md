# fiktiva-north (FICTIONAL)

Second synthetic jurisdiction. Invented for tests: no real law, person or place. Sources are example.org placeholders. Do not tidy the differences below away: tests in `test/fiktiva-north.test.mjs` (and later the reuse e2e 13-u22 and archive eval 13-u18) rely on them.

## Planted differences from fiktiva-city

| # | Difference | Where | Direction |
|---|---|---|---|
| a | Collection fees for household waste are forbidden | north L4 `L4/fiktiva/north-statutes/art-7`; no fiktiva-city article forbids them | lawful in city, unlawful in north |
| b | Street stalls need no permit, only a notice | north L6 `L6/fiktiva/north-bylaws/art-3` vs city `L6/fiktiva/bylaws/art-3` (permit needed) | unlawful in city, lawful in north |
| c | Control: lantern drone ban | north L2 `L2/fiktiva/north-union/art-4` and city `L2/fiktiva/union/art-4`, identical text | same in both |
| d | Corpus version string | north L4 is `0.2.0`, city L4 is `0.1.0`, so the pins and `corpus_version` differ (staleness flag) | |
| e | No regional layer | north L5 is `not_applicable`; city pins `fiktiva-region` | |
| f | Other overlay differences | notice days 14 vs 10, `competence.yaml` offices for waste-collection and school-meals, own external routes | |

`context-fixtures.yaml` holds the declared context of a typical north problem: lower budget band (`<1k` vs `<10k`), fewer people, climate class D vs B.

L1 and L3 pin the shared fiktiva corpora (same invented world). Follow-up: fiktiva-city has no article that explicitly allows a collection fee; its lawfulness is silence at L1 to L6.
