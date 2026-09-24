#!/usr/bin/env python3
"""Regenerates tests/fixtures/parity.json from the reference implementation (sig-node-ci-assistant, the Python
CLI). The TypeScript port is checked against it: same signals, same Jev state, same questions, same verdicts.

Usage: python3 scripts/parity_fixture.py [path/to/sig-node-ci-assistant]   (default: ../sig-node-ci-assistant)
Uses the CLI's on-disk cache (.cache/) for item details, so run the CLI first to populate it. No network."""
import glob, itertools, json, os, sys
from pathlib import Path

ref = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent.parent / "sig-node-ci-assistant").resolve()
os.environ.setdefault("TYPESAFE_API_KEY", "fixture-only")   # lib.jev builds its headers at import time
sys.path.insert(0, str(ref))
from sig_node_assistant import triage               # noqa: E402
from lib import board                              # noqa: E402

cache = ref / ".cache"
items_by_key = {}
for f in cache.glob("col_kubernetes_151_*.json"):
    for it in json.loads(f.read_text()):
        items_by_key[(it["repository"], it["number"])] = it

items = []
for f in sorted(cache.glob("kubernetes_*_*.json")):
    if f.name.startswith(("kubernetes_kubernetes_", "kubernetes_test-infra_")):
        repo = f.name.rsplit("_", 1)[0].replace("_", "/", 1); num = int(f.stem.rsplit("_", 1)[1])
    else:
        continue
    d = json.loads(f.read_text())
    it = items_by_key.get((repo, num))
    kind = "PullRequest" if "files" in d else "Issue"
    if not it:   # not in a cached column: synthesise the item summary the same way board.items_in does
        it = {"id": f"PVTI_fixture_{num}", "rest_id": num, "status": "Triage", "type": kind, "number": num,
              "url": d["url"], "repository": repo, "title": d["title"], "state": d["state"], "merged": False,
              "draft": bool(d.get("isDraft")), "labels": [l["name"] for l in d["labels"]], "assignees": [],
              "updated_at": d["createdAt"], "closed_at": None}
    items.append({"item": it, "detail": d, "kind": kind,
                  "signals": triage.signals(d, kind), "state": triage.build_state(it, d, kind),
                  "state_chars": len(json.dumps(triage.build_state(it, d, kind)))})

questions = {k: triage.questions(k) for k in ("Issue", "PullRequest")}

# decision grid: every combination the policy branches on
def ans(p, ci_split, node, prio=(0.2, 0.7, 0.1), conf=0.6):
    fail, cov, infra = ci_split; feat = round(1 - fail - cov - infra, 4)
    return {"in_scope": {"type": "noul", "noul": p},
            "bucket": {"type": "choice", "choice": "failing_or_flaking_test", "confidence": 0.5,
                       "probabilities": {"failing_or_flaking_test": fail, "test_coverage": cov, "ci_infrastructure": infra, "feature_or_product_change": feat}},
            "owner": {"type": "choice", "choice": "node", "confidence": 0.5, "probabilities": {"node": node, "other": round(1 - node, 4) * 0.9, "unclear": round(1 - node, 4) * 0.1}},
            "priority": {"type": "score", "score": 0.5, "confidence": conf, "probabilities": {"0": prio[0], "1": prio[1], "2": prio[2]}}}

decisions = []
for p, ci, node, routed, plabel in itertools.product(
        [0.0, 0.34, 0.35, 0.36, 0.5, 0.64, 0.65, 0.66, 1.0],
        [(0.1, 0.0, 0.0), (0.4, 0.2, 0.1), (0.5, 0.3, 0.2)],
        [0.2, 0.6, 0.95], [False, True], [None, "priority/important-soon"]):
    a = ans(p, ci, node)
    sig = {"human_slash_routing_comments": [{"who": "alice", "cmd": "/sig node"}, {"who": "bob", "cmd": "/sig node"}, {"who": "alice", "cmd": "/area kubelet"}] if routed else [],
           "manual_sig_node_routing_present": routed, "human_comment_count": 3, "triage_accepted_already": False,
           "priority_label_already": plabel}
    v, why = triage.decide(a, sig); pr, pwhy = triage.priority(a, sig)
    decisions.append({"answers": a, "signals": sig, "verdict": v, "why": why, "priority": pr, "priority_why": pwhy})
for prio in [(0.7, 0.2, 0.1), (0.1, 0.2, 0.7), (0.3, 0.3, 0.4), (0.5, 0.5, 0.0)]:
    a = ans(0.9, (0.5, 0.3, 0.2), 0.9, prio); sig = decisions[0]["signals"] | {"priority_label_already": None}
    pr, pwhy = triage.priority(a, sig); decisions.append({"answers": a, "signals": sig, "verdict": "KEEP", "why": triage.decide(a, sig)[1], "priority": pr, "priority_why": pwhy})

lanes = []
for draft, blocked, review, lgtm in itertools.product([False, True], [[], ["do-not-merge/hold"], ["needs-rebase"]], [None, "APPROVED", "CHANGES_REQUESTED"], [False, True]):
    sig = {"is_draft": draft, "blocked_labels": blocked, "review_decision": review, "has_lgtm_label": lgtm}
    lanes.append({"signals": sig, "lane": triage.pr_lane(sig)})

fields = json.loads((cache / "fields_kubernetes_151.json").read_text())
commands = []
for e in items[:6]:
    it, kind = e["item"], e["kind"]
    commands.append({"item": it, "kind": kind, "priority": "important-longterm", "lane": "Issues - To do" if kind == "Issue" else "PRs - Needs Reviewer",
                     "prow": " ".join(__import__("shlex").quote(a) for a in board.prow_argv(kind, it["repository"], it["number"], "important-longterm")),
                     "move": " ".join(board.move_argv(it["id"], "Issues - To do" if kind == "Issue" else "PRs - Needs Reviewer", fields)),
                     "archive": " ".join(board.move_argv(it["id"], "Archive-it", fields))})

out = {"source": "sig-node-ci-assistant", "items": items, "questions": questions, "decisions": decisions, "lanes": lanes,
       "fields": fields, "commands": commands}
dst = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "parity.json"
dst.write_text(json.dumps(out, indent=1))   # insertion order: the policy sums probabilities in dict order
print(f"wrote {dst}: {len(items)} items, {len(decisions)} decisions, {len(lanes)} lanes, {len(commands)} command sets")
