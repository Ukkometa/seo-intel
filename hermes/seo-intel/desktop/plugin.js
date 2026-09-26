/**
 * SEO Intel — Hermes Desktop half.
 *
 * A Search Review pane plus a status-bar chip. Data comes from the package's
 * own backend (dashboard/plugin_api.py, mounted at /api/plugins/seo-intel/),
 * which shells out to the local seo-intel CLI. SEO Intel stays read-only:
 * the only write this pane performs is queuing a Hermes agent brief.
 *
 * Plain ESM, loaded uncompiled by Hermes Desktop — UI is jsx() calls.
 * Folder name must equal `id` (seo-intel).
 */

import { cn, haptic, host, Tip, useQuery, useQueryClient } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'seo-intel'
let api = null

const BUCKETS = [
  { key: 'needs_input', label: 'Needs you', hint: 'A person decides. Agents must not guess these.' },
  { key: 'safe_now', label: 'Safe now', hint: 'Hygiene with a fix template, found by a rule. An agent may act unattended.' },
  { key: 'opportunities', label: 'Bets', hint: 'Growth bets to weigh, not tasks.' },
  { key: 'working', label: 'Working', hint: 'Checks that passed on a fresh crawl.' }
]

function useProjects() {
  return useQuery({
    queryKey: [ID, 'projects'],
    queryFn: () => api.rest('/projects', { timeoutMs: 15000 }),
    staleTime: 60_000,
    retry: 1
  })
}

function useReview(project) {
  return useQuery({
    queryKey: [ID, 'review', project],
    queryFn: () => api.rest(`/review?project=${encodeURIComponent(project)}`, { timeoutMs: 120_000 }),
    enabled: Boolean(project),
    staleTime: 30_000,
    refetchInterval: 180_000,
    retry: 1
  })
}

function freshnessLabel(f) {
  if (!f) return ''
  if (f.state === 'fresh') return `crawl ${f.age_days}d old`
  if (f.state === 'stale') return `crawl ${f.age_days}d old — re-crawl before acting`
  return 'no crawl data yet'
}

function ReviewItem({ item, project, bucket }) {
  const [busy, setBusy] = useState(false)
  const basis = item.blocked_by ? `Unblocked by: ${item.blocked_by}` : (item.decision_basis || [])[0] || ''
  const url = item.evidence?.[0]?.url || null

  const copy = async () => {
    haptic('tap')
    const ok = await api.os.writeClipboard(String(item.safe_action || item.title))
    host.notify({ kind: ok ? 'success' : 'info', message: ok ? 'Fix copied' : String(item.safe_action || item.title) })
  }
  const queue = async () => {
    if (busy) return
    setBusy(true)
    haptic('tap')
    try {
      const res = await api.rest('/agent-task', {
        method: 'POST',
        timeoutMs: 15000,
        body: {
          project,
          action: 'generate_brief',
          finding: {
            finding: item.title,
            kind: item.category,
            url,
            proof: (item.decision_basis || []).join(' '),
            suggested_action: item.safe_action
          }
        }
      })
      host.notify({ kind: res?.ok ? 'success' : 'warning', message: res?.ok ? 'Brief queued for a Hermes agent' : 'Could not queue the brief' })
    } catch (err) {
      host.notify({ kind: 'warning', message: `Could not queue the brief: ${err?.message || err}` })
    } finally {
      setBusy(false)
    }
  }

  // Only tokens Hermes actually defines: --ui-danger, --ui-success, --ui-accent (no warning token exists).
  const dotColor = item.severity === 'critical' ? 'var(--ui-danger)'
    : item.severity === 'warn' ? 'var(--ui-accent)'
    : item.severity === 'ok' ? 'var(--ui-success)'
    : 'var(--ui-text-quaternary)'

  return jsxs('div', {
    className: 'flex gap-2 border-b border-(--ui-stroke-secondary) py-2',
    children: [
      jsx('span', { className: 'mt-1.5 inline-block h-2 w-2 flex-none rounded-full', style: { background: dotColor } }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsx('div', { className: 'text-sm font-medium leading-snug', children: item.title }),
          basis ? jsx('div', { className: 'mt-0.5 text-xs text-(--ui-text-tertiary)', children: basis }) : null,
          bucket === 'working'
            ? jsx('div', { className: 'mt-0.5 text-xs text-(--ui-text-tertiary)', children: item.observed || '' })
            : jsxs('div', {
                className: 'mt-1 flex items-center gap-2 text-[0.6875rem] text-(--ui-text-quaternary)',
                children: [
                  jsx('span', { children: item.category }),
                  jsx('button', { type: 'button', onClick: copy, className: 'rounded border border-(--ui-stroke-secondary) px-1.5 py-0.5 hover:bg-(--chrome-action-hover)', children: 'Copy fix' }),
                  bucket !== 'opportunities'
                    ? jsx('button', { type: 'button', onClick: queue, disabled: busy, className: 'rounded border border-(--ui-stroke-secondary) px-1.5 py-0.5 hover:bg-(--chrome-action-hover)', children: busy ? 'Queuing…' : 'Send to agent' })
                    : null
                ]
              })
        ]
      })
    ]
  })
}

function ReviewPane() {
  const projects = useProjects()
  const list = projects.data?.projects || []
  const [chosen, setChosen] = useState(null)
  const project = chosen || list[0]?.project || null
  const review = useReview(project)
  const [bucket, setBucket] = useState('needs_input')
  const qc = useQueryClient()

  if (projects.isLoading) return jsx('div', { className: 'p-3 text-sm text-(--ui-text-tertiary)', children: 'Finding SEO Intel projects…' })
  if (projects.error) return jsx('div', { className: 'p-3 text-sm text-(--ui-text-tertiary)', children: 'SEO Intel backend unavailable. Enable the seo-intel plugin (hermes plugins enable seo-intel) and make sure the CLI is installed.' })
  if (!list.length) return jsx('div', { className: 'p-3 text-sm text-(--ui-text-tertiary)', children: 'No SEO Intel projects yet. Run `seo-intel setup` or `seo-intel scan <domain>` first.' })

  const data = review.data?.review
  const items = data ? (data[bucket] || []) : []
  const refresh = () => {
    haptic('tap')
    qc.invalidateQueries({ queryKey: [ID, 'review', project] })
  }

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('div', { className: 'font-medium', children: 'Search Review' }),
          jsx('select', {
            value: project || '',
            onChange: (e) => { setChosen(e.target.value); setBucket('needs_input') },
            className: 'ml-auto max-w-[55%] rounded border border-(--ui-stroke-secondary) bg-transparent px-1.5 py-0.5 text-xs',
            children: list.map(p => jsx('option', { value: p.project, children: p.siteName || p.project }, p.project))
          }),
          jsx(Tip, { label: 'Refresh', children: jsx('button', { type: 'button', onClick: refresh, className: 'rounded border border-(--ui-stroke-secondary) px-1.5 py-0.5 text-xs hover:bg-(--chrome-action-hover)', children: '↻' }) })
        ]
      }),
      data ? jsx('div', {
        className: cn('text-xs', data.freshness?.state === 'fresh' ? 'text-(--ui-text-tertiary)' : 'text-(--ui-accent)'),
        children: freshnessLabel(data.freshness)
      }) : null,
      jsx('div', {
        className: 'flex gap-1',
        children: BUCKETS.map(b => jsx('button', {
          type: 'button',
          onClick: () => { haptic('tap'); setBucket(b.key) },
          className: cn('rounded px-2 py-1 text-xs transition-colors', bucket === b.key ? 'bg-(--chrome-action-hover) text-foreground' : 'text-(--ui-text-tertiary) hover:text-foreground'),
          children: `${b.label}${data ? ` ${(data[b.key] || []).length}` : ''}`
        }, b.key))
      }),
      jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: BUCKETS.find(b => b.key === bucket)?.hint }),
      review.isLoading
        ? jsx('div', { className: 'py-3 text-xs text-(--ui-text-tertiary)', children: 'Reviewing…' })
        : review.error
          ? jsx('div', { className: 'py-3 text-xs text-(--ui-text-tertiary)', children: `Review failed: ${review.error?.message || 'seo-intel command failed'}` })
          : jsx('div', {
              className: 'min-h-0 flex-1 overflow-auto',
              children: items.length
                ? items.map(it => jsx(ReviewItem, { item: it, project, bucket }, it.id))
                : jsx('div', { className: 'py-3 text-xs text-(--ui-text-tertiary)', children: bucket === 'working' && data?.freshness?.state !== 'fresh' ? 'Passes are withheld until the crawl is fresh.' : 'Nothing here.' })
            })
    ]
  })
}

function ReviewChip() {
  const projects = useProjects()
  const project = projects.data?.projects?.[0]?.project || null
  const review = useReview(project)
  const data = review.data?.review
  const needs = data?.needs_input?.length || 0
  const safe = data?.safe_now?.length || 0
  const label = !project ? 'SEO Intel: no project' : !data ? 'SEO Intel: reviewing…' : needs ? `${needs} decision${needs === 1 ? '' : 's'} waiting on you` : `${safe} safe fixes, nothing waiting on you`
  return jsx(Tip, {
    label,
    children: jsx('button', {
      type: 'button',
      className: cn('inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors', needs ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)', 'hover:bg-(--chrome-action-hover) hover:text-foreground'),
      onClick: () => { haptic('tap'); host.notify({ kind: 'info', message: label }) },
      children: data ? `SEO ${needs}▲ ${safe}✓` : 'SEO Intel'
    })
  })
}

export default {
  id: ID,
  name: 'SEO Intel',
  register(ctx) {
    api = ctx
    ctx.register({ id: 'pane', area: 'panes', title: 'Search Review', data: { placement: 'right', width: '360px' }, render: () => jsx(ReviewPane, {}) })
    ctx.register({ id: 'chip', area: 'statusBar.right', order: 118, render: () => jsx(ReviewChip, {}) })
  }
}
