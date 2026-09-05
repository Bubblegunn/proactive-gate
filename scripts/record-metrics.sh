#!/bin/sh
# Appends one line per day to metrics.csv on the `metrics` branch:
# date,stars,forks,views_14d,unique_visitors_14d,clones_14d,unique_cloners_14d,npm_downloads_yesterday
set -eu
repo="${GITHUB_REPOSITORY:?}"
day=$(date -u +%F)
stars=$(gh api "repos/$repo" --jq '.stargazers_count')
forks=$(gh api "repos/$repo" --jq '.forks_count')
# Traffic needs push access; the job token cannot read it (403). Add a fine-grained
# METRICS_TOKEN secret (this repo, Administration: read) and the two columns fill in.
traffic() { gh api "repos/$repo/traffic/$1" --jq '"\(.count),\(.uniques)"' 2>/dev/null | grep -E '^[0-9]+,[0-9]+$' || echo ","; }
views=$(traffic views)
clones=$(traffic clones)
downloads=""
if [ -n "${NPM_PACKAGE:-}" ]; then
  downloads=$(curl -fsS "https://api.npmjs.org/downloads/point/last-day/$NPM_PACKAGE" 2>/dev/null | sed -n 's/.*"downloads":\([0-9]*\).*/\1/p' || true)
fi
line="$day,$stars,$forks,$views,$clones,$downloads"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git fetch -q origin metrics 2>/dev/null; then
  git checkout -q metrics
else
  git checkout -q --orphan metrics
  git rm -rfq . >/dev/null 2>&1 || true
  printf 'date,stars,forks,views_14d,unique_visitors_14d,clones_14d,unique_cloners_14d,npm_downloads_yesterday\n' > metrics.csv
fi
if grep -q "^$day," metrics.csv 2>/dev/null; then
  echo "already recorded $day"; exit 0
fi
echo "$line" >> metrics.csv
git add metrics.csv
git commit -qm "metrics: $day"
git push -q origin metrics
echo "$line"
