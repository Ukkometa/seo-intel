"""SEO Intel dashboard plugin backend.

Mounted at /api/plugins/seo-intel/ by Hermes dashboard.

Contract: SEO Intel is read-only. This backend shells out to the local
seo-intel CLI for intelligence JSON and only writes Hermes-side task stubs.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

try:
    from hermes_constants import get_hermes_home
except Exception:  # pragma: no cover
    def get_hermes_home() -> Path:  # type: ignore[misc]
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")

router = APIRouter()

CACHE_TTL_SECONDS = 20
_CACHE: Dict[str, Dict[str, Any]] = {}


class AgentTaskBody(BaseModel):
    project: str = "carbium"
    finding: dict[str, Any]
    action: str = "generate_brief"
    # The operator can edit/override the brief in the cockpit before dispatch.
    prompt: str | None = None
    # "queued" (just record) or "running" (handed to a Hermes agent now).
    status: str = "queued"


AgentTaskBody.model_rebuild(_types_namespace={"Any": Any})


_SIGNAL_FIX_HINT = {
    "entity authority": "Add clear author/org bylines, About/Team content, and links out to authoritative sources.",
    "structured claims": "State concrete facts as direct sentences (numbers, named features, comparisons) instead of vague marketing copy.",
    "answer density": "Lead each section with a direct answer to the likely question before any preamble.",
    "qa proximity": "Put question-shaped subheadings directly above their answers (FAQ-style structure).",
    "freshness": "Add or update a visible last-updated date and refresh any stale facts.",
    "schema coverage": "Add JSON-LD structured data (FAQPage, Article, Product — whichever fits the page).",
}


def _kind_brief_lines(kind: str, f: dict[str, Any]) -> List[str]:
    """Kind-specific instructions — each finding type carries different structured
    evidence (signal scores, page counts, intent) that a generic template throws away."""
    if kind == "citability":
        lines: List[str] = []
        score = f.get("score")
        if score is not None:
            lines.append(f"Current AI citability score: {score}/100.")
        weak = f.get("weak_signals") or []
        if weak:
            lines.append(f"Weakest signals: {', '.join(weak)}.")
            lines += [f"  - {w}: {_SIGNAL_FIX_HINT.get(w, 'Improve this signal.')}" for w in weak]
        return lines
    if kind == "quick_wins":
        return ["This is a quick win — keep the fix surgical and scoped to exactly what's described above."]
    if kind == "technical_gaps":
        return ["This is a technical/structural gap — check the shared page template/component, not just one page's copy; the same issue likely repeats across every page using that template."]
    if kind == "content_gaps":
        return ["This is a content gap — competitors cover this topic and you don't. Write genuinely useful content; don't pad word count."]
    if kind == "keyword_gaps":
        return ["This is a keyword gap — work the target phrase naturally into headings/body copy. Don't keyword-stuff."]
    if kind == "site_watch":
        return ["This was flagged by ongoing site monitoring — confirm it's still true before fixing (it may be stale)."]
    return []


def _build_brief(project: str, finding: dict[str, Any], source_path: Optional[str] = None, is_git: bool = False) -> str:
    """Turn one SEO Intel finding into a self-contained implementation brief an
    agent can act on without SEO knowledge. SEO Intel stays read-only evidence —
    the agent edits the actual site/source."""
    f = finding or {}
    title = f.get("finding") or f.get("proof") or "SEO Intel opportunity"
    kind = f.get("kind") or "gap"
    url = f.get("url") or ""
    proof = f.get("proof") or ""
    action = f.get("suggested_action") or "Improve this page for SEO and AI citability."
    lines = [
        f"Fix one SEO Intel finding for project '{project}'.",
        "SEO Intel is read-only evidence — do NOT call seo-intel to change anything; you make the edit.",
    ]
    if source_path:
        lines.append(f"Site source: {source_path}")
        if is_git:
            lines.append("It's a git repo — work on a new branch; don't push or merge unless asked.")
    else:
        lines.append("No source path is on file for this project — ask the operator where the site's code lives before editing.")
    lines += [
        "",
        f"Opportunity: {title}",
        f"Type: {kind}",
    ]
    if url:
        lines.append(f"Target page: {url}")
    if proof:
        lines.append(f"Evidence: {proof}")
    lines.append(f"What to do: {action}")
    kind_lines = _kind_brief_lines(kind, f)
    if kind_lines:
        lines += [""] + kind_lines
    lines += [
        "",
        "Edit the page source (content, headings, JSON-LD / structured data, FAQ blocks,",
        "internal links) so the change shows up in the RAW HTML — that's what search bots and",
        "AI assistants read. Keep it accurate and on-brand; never fabricate facts.",
    ]
    if url:
        lines += ["", f"When the change is live, verify the lift with:  seo-intel rescore {project} {url}"]
    return "\n".join(lines)


def _installed_seo_root() -> Optional[Path]:
    """Read ~/.seo-intel/install.json — the local registry any seo-intel
    checkout writes on every CLI run (see cli.js registerInstallLocation()).
    Harness-agnostic: Hermes, a Claude Code plugin, or any other tool on this
    machine resolves the same way, with no env var or hardcoded path."""
    registry = Path.home() / ".seo-intel" / "install.json"
    try:
        data = json.loads(registry.read_text(encoding="utf-8"))
        root = data.get("root")
        if root and (Path(root) / "cli.js").exists():
            return Path(root)
    except Exception:
        pass
    return None


def _seo_root() -> Path:
    # No hardcoded personal-machine fallback here on purpose — a fresh install
    # has no local seo-intel checkout to guess at. Resolution order: explicit
    # env var override > the local install registry > cwd. If none of those
    # find a source checkout, _command_candidates() below still finds the
    # globally-installed `seo-intel` / `npx seo-intel` binary, which needs no
    # path at all.
    raw = os.environ.get("SEO_INTEL_ROOT") or os.environ.get("HERMES_SEO_INTEL_ROOT")
    if raw:
        return Path(raw).expanduser()
    installed = _installed_seo_root()
    if installed:
        return installed
    return Path.cwd()


def _command_candidates(root: Path) -> List[List[str]]:
    candidates: List[List[str]] = []
    local_cli = root / "cli.js"
    if local_cli.exists():
        candidates.append(["node", str(local_cli)])
    if shutil.which("seo-intel"):
        candidates.append(["seo-intel"])
    if shutil.which("npx"):
        candidates.append(["npx", "seo-intel"])
    return candidates


def _run_json(args: List[str], cwd: Optional[Path] = None, timeout: int = 90) -> Dict[str, Any]:
    root = _seo_root()
    errors: List[Dict[str, Any]] = []
    for base in _command_candidates(root):
        cmd = base + args
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(cwd or root),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                env={**os.environ, "NO_COLOR": "1"},
            )
        except FileNotFoundError as exc:
            errors.append({"command": cmd, "error": str(exc)})
            continue
        except subprocess.TimeoutExpired:
            errors.append({"command": cmd, "error": f"timed out after {timeout}s"})
            continue
        if proc.returncode != 0:
            errors.append({
                "command": cmd,
                "exit_code": proc.returncode,
                "stderr": proc.stderr[-2000:],
                "stdout": proc.stdout[-1000:],
            })
            continue
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            errors.append({
                "command": cmd,
                "error": f"invalid json: {exc}",
                "stdout": proc.stdout[:2000],
            })
            continue
    raise HTTPException(status_code=502, detail={"message": "seo-intel command failed", "errors": errors})


def _project_config(project: str) -> Optional[Dict[str, Any]]:
    path = _seo_root() / "config" / f"{project}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _source_info(data: Dict[str, Any]) -> Dict[str, Any]:
    """sourcePath works whether it's a git repo or a plain folder — same field
    either way, git-ness is just auto-detected from a `.git` dir, not declared."""
    raw = data.get("sourcePath")
    if not raw:
        return {"sourcePath": None, "isGitRepo": False}
    return {"sourcePath": raw, "isGitRepo": (Path(raw) / ".git").is_dir()}


def _read_projects() -> List[Dict[str, Any]]:
    root = _seo_root()
    cfg_dir = root / "config"
    projects: List[Dict[str, Any]] = []
    if not cfg_dir.is_dir():
        return projects
    for path in sorted(cfg_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            name = data.get("project") or path.stem
            ctx = data.get("context") or {}
            target = data.get("target") or {}
            competitors = data.get("competitors") or []
            owned = data.get("owned") or []
            projects.append({
                "project": name,
                "siteName": ctx.get("siteName") or name,
                "url": target.get("url") or ctx.get("url") or "",
                "industry": ctx.get("industry") or "",
                "competitors": len(competitors),
                "owned": len(owned),
                **_source_info(data),
            })
        except Exception:
            continue
    return projects


def _as_list(value: Any) -> List[Any]:
    return value if isinstance(value, list) else []


def _score_value(item: Dict[str, Any]) -> int:
    impact = str(item.get("impact") or item.get("priority") or item.get("tier") or "").lower()
    if "critical" in impact or "high" in impact:
        return 90
    if "medium" in impact or "fair" in impact:
        return 65
    if "low" in impact:
        return 35
    if "score" in item:
        try:
            score = float(item.get("score") or 0)
            # low citability is a high opportunity
            return max(20, min(95, int(100 - score)))
        except Exception:
            pass
    return 55


def _finding_from(kind: str, item: Dict[str, Any], project: str) -> Dict[str, Any]:
    title = (
        item.get("topic")
        or item.get("gap")
        or item.get("issue")
        or item.get("summary")
        or item.get("title")
        or item.get("url")
        or kind
    )
    action = (
        item.get("suggested_title")
        or item.get("fix")
        or item.get("suggested_action")
        or item.get("why_it_matters")
        or "Generate Hermes implementation brief"
    )
    url = item.get("url") or item.get("page") or None
    proof = item.get("covered_by") or item.get("competitors_with_it") or url or ""
    status = "Alert" if kind == "site_watch" else "New"
    if kind == "quick_wins":
        status = "Quick win"
    if kind == "citability":
        status = "Weak" if _score_value(item) > 70 else "Watch"
    return {
        "id": item.get("_insight_id") or item.get("id") or f"{kind}:{hash(json.dumps(item, sort_keys=True, default=str))}",
        "kind": kind,
        "status": status,
        "project": project,
        "finding": str(title),
        "intent": item.get("format") or item.get("ai_intents") or kind.replace("_", " "),
        "value": _score_value(item),
        "confidence": item.get("confidence") or (0.86 if item.get("_insight_id") else 0.62),
        "suggested_action": str(action),
        "proof": proof,
        "url": url,
        "raw": item,
    }


def _finding_from_opportunity(o: Dict[str, Any], project: str) -> Dict[str, Any]:
    """Map a seo-intel `opportunities[]` row (real fields) to a ledger finding."""
    status_map = {"poor": "Poor", "weak": "Weak", "needs-work": "Needs work", "good": "Good"}
    side = o.get("side")
    weak = o.get("weak_signals") or []
    return {
        "id": o.get("id") or o.get("url"),
        "kind": o.get("kind") or "citability",
        "status": "Attack" if side == "attack" else status_map.get(o.get("status"), str(o.get("status") or "New")),
        "project": project,
        "finding": str(o.get("finding") or o.get("url") or ""),
        "intent": o.get("intent") or (", ".join(weak) if weak else o.get("kind")),
        "value": o.get("value", 0),
        "confidence": o.get("confidence", 0),
        "suggested_action": str(o.get("suggested_action") or "Generate Hermes implementation brief"),
        "proof": o.get("proof") or o.get("url") or "",
        "url": o.get("url"),
        "side": side,
        "domain": o.get("domain"),
        "score": o.get("score"),
        "weak_signals": weak,
        "raw": o,
    }


def _dedupe_opps(opps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse opportunities sharing (domain, suggested_action) into one row + count."""
    groups: Dict[Any, Dict[str, Any]] = {}
    for o in opps:
        if not isinstance(o, dict):
            continue
        key = (o.get("domain"), o.get("suggested_action"))
        g = groups.get(key)
        if g is None:
            groups[key] = {**o, "_count": 1, "_examples": [o.get("finding")]}
        else:
            g["_count"] += 1
            if len(g["_examples"]) < 4:
                g["_examples"].append(o.get("finding"))
            if (o.get("value") or 0) > (g.get("value") or 0):
                g["value"], g["score"], g["status"] = o.get("value"), o.get("score"), o.get("status")
    out: List[Dict[str, Any]] = []
    for g in groups.values():
        n = g.pop("_count", 1)
        examples = g.pop("_examples", [])
        if n > 1:
            g["finding"] = f"{g.get('domain')} — {n} pages"
            g["proof"] = ", ".join(str(x) for x in examples[:3]) + (" …" if n > 3 else "")
            g["count"] = n
        out.append(g)
    out.sort(key=lambda x: x.get("value", 0), reverse=True)
    return out


def _summarize(envelope: Dict[str, Any]) -> Dict[str, Any]:
    project = envelope.get("project") or "unknown"
    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    projects = _read_projects()
    project_meta = next((p for p in projects if p.get("project") == project), None)

    summary = data.get("summary") if isinstance(data.get("summary"), dict) else {}
    opportunities = data.get("opportunities") if isinstance(data.get("opportunities"), list) else []

    # ── Findings = varied insight gaps + DEDUPED citability opportunities ──
    # Insight buckets (keyword / content / technical / quick-win / watch) restore the
    # variety the single-ledger view had; citability rows are collapsed by
    # (domain, action) so identical page-fixes don't flood the table.
    buckets: Dict[str, List[Any]] = {}
    insights = data.get("insights") if isinstance(data.get("insights"), dict) else {}
    for key, value in insights.items():
        buckets[key] = _as_list(value)

    insight_findings: List[Dict[str, Any]] = []
    for key in ["site_watch", "quick_wins", "content_gaps", "keyword_gaps", "technical_gaps", "new_pages"]:
        for item in buckets.get(key, [])[:25]:
            if isinstance(item, dict):
                insight_findings.append(_finding_from(key, item, project))

    fix_opps = [o for o in opportunities if isinstance(o, dict) and o.get("side") == "fix"]
    attack_opps = [o for o in opportunities if isinstance(o, dict) and o.get("side") == "attack"]
    fix_findings = [_finding_from_opportunity(o, project) for o in _dedupe_opps(fix_opps)]
    attack_findings = [_finding_from_opportunity(o, project) for o in _dedupe_opps(attack_opps)]

    # Merged single-ledger view (the current UI renders `findings`): varied + ranked.
    findings = insight_findings + fix_findings + attack_findings
    findings.sort(key=lambda f: f.get("value", 0), reverse=True)

    # Citability average — prefer the envelope summary (your pages only).
    avg_score = summary.get("avg_citability_owned")
    if avg_score is None:
        citability = _as_list(data.get("citability"))
        scores = [x.get("score") for x in citability if isinstance(x, dict) and isinstance(x.get("score"), (int, float))]
        avg_score = round(sum(scores) / len(scores), 1) if scores else None

    fix_count = summary.get("fix_opportunities")
    if fix_count is None:
        fix_count = len([f for f in findings if f.get("side") != "attack"])

    cards = [
        {"label": "Projects", "value": len(projects) or 1, "hint": "configured SEO workspaces"},
        {"label": "Competitors", "value": (project_meta or {}).get("competitors", "—"), "hint": "tracked for active project"},
        {"label": "Your gaps", "value": fix_count, "hint": "your pages to fix"},
        {"label": "AI citability", "value": "—" if avg_score is None else avg_score, "hint": "your avg page score"},
        {"label": "Attack targets", "value": summary.get("attack_targets", "—"), "hint": "thin competitor pages"},
    ]
    return {
        "cards": cards,
        "findings": findings[:80],
        "fix": fix_findings[:60],
        "attack": attack_findings[:40],
        "signals": summary.get("signals") or {},
        "projects": projects,
        "summary": summary,
        "buckets": {"opportunities": len(opportunities)},
    }


@router.get("/projects")
def get_projects() -> Dict[str, Any]:
    return {"ok": True, "root": str(_seo_root()), "projects": _read_projects()}


@router.get("/intel")
def get_intel(
    project: str = Query("carbium"),
    feed: str = Query("audit", alias="for"),
    refresh: bool = Query(False),
) -> Dict[str, Any]:
    feed = feed or "audit"
    key = f"{project}:{feed}"
    now = time.time()
    if not refresh and key in _CACHE and now - _CACHE[key]["cached_at"] < CACHE_TTL_SECONDS:
        return _CACHE[key]["payload"]
    envelope = _run_json(["intel", project, "--for", feed, "--format", "json"])
    payload = {"ok": True, "cached": False, "summary": _summarize(envelope), "envelope": envelope}
    _CACHE[key] = {"cached_at": now, "payload": payload}
    return payload


@router.get("/rescore")
def rescore(project: str = Query("carbium"), url: str = Query(...)) -> Dict[str, Any]:
    # Read-only re-check of one URL's AI citability (raw-HTML / what-bots-see lens).
    # Shells out to `seo-intel rescore` — returns before/after/delta + signals.
    result = _run_json(["rescore", project, url, "--format", "json"], timeout=60)
    return {"ok": True, "result": result}


@router.post("/agent-task")
def create_agent_task(body: AgentTaskBody) -> Dict[str, Any]:
    # MVP Hermes-side stub: no SEO Intel mutation. This gives the UI a real
    # durable handoff artifact that an agent/cron/kanban bridge can consume.
    plugin_dir = get_hermes_home() / "plugins" / "seo-intel"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    tasks_path = plugin_dir / "agent_tasks.json"
    try:
        tasks = json.loads(tasks_path.read_text(encoding="utf-8")) if tasks_path.exists() else []
    except Exception:
        tasks = []
    finding = body.finding
    if body.prompt:
        prompt = body.prompt
    else:
        cfg = _project_config(body.project) or {}
        src = _source_info(cfg)
        prompt = _build_brief(body.project, finding, src["sourcePath"], src["isGitRepo"])
    task = {
        "id": f"seo-{int(time.time() * 1000)}",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "project": body.project,
        "action": body.action,
        "status": body.status if body.status in ("queued", "running", "done") else "queued",
        "prompt": prompt,
        "finding": finding,
    }
    tasks.insert(0, task)
    tasks_path.write_text(json.dumps(tasks[:200], indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": True, "task": task, "path": str(tasks_path)}


@router.post("/agent-task/status")
def set_agent_task_status(id: str = Query(...), status: str = Query("done")) -> Dict[str, Any]:
    # Hermes-side write only (agent_tasks.json). Moves a task across the board.
    tasks_path = get_hermes_home() / "plugins" / "seo-intel" / "agent_tasks.json"
    try:
        tasks = json.loads(tasks_path.read_text(encoding="utf-8")) if tasks_path.exists() else []
    except Exception:
        tasks = []
    found = False
    for t in tasks:
        if t.get("id") == id:
            t["status"] = status
            t["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            found = True
            break
    if found:
        tasks_path.write_text(json.dumps(tasks[:200], indent=2, ensure_ascii=False), encoding="utf-8")
    return {"ok": found, "id": id, "status": status}


@router.get("/agent-tasks")
def list_agent_tasks() -> Dict[str, Any]:
    tasks_path = get_hermes_home() / "plugins" / "seo-intel" / "agent_tasks.json"
    try:
        tasks = json.loads(tasks_path.read_text(encoding="utf-8")) if tasks_path.exists() else []
    except Exception:
        tasks = []
    return {"ok": True, "tasks": tasks}
