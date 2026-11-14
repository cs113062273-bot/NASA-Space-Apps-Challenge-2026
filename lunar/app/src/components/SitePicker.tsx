import { useEffect, useRef, useState } from 'react'
import type { SiteRecord } from '../lib/data'
import { fmtLat } from '../lib/ui'
import { GROUP_COLOR } from './MapView'

const GROUPS = ['Flown', 'Upcoming', 'Artemis III region', 'Best-lit', 'Reference', 'Apollo', 'Other landers', 'My sites']

export function SitePicker({ sites, site, pinned, onSelect, onPin, onRemove }: {
  sites: SiteRecord[]; site: SiteRecord; pinned: string[]
  onSelect: (id: string) => void; onPin: (id: string) => void; onRemove: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const matches = sites.filter(s => `${s.name} ${s.group}`.toLowerCase().includes(query.trim().toLowerCase()))

  useEffect(() => {
    const el = popup.current
    if (!el) return
    let frame = 0
    const position = () => {
      if (!trigger.current) return
      const rect = trigger.current.getBoundingClientRect()
      const width = Math.min(560, innerWidth - 24)
      const top = Math.min(rect.bottom + 8, innerHeight - 180)
      el.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`
      el.style.top = `${Math.max(8, top)}px`
      el.style.width = `${width}px`
      el.style.maxHeight = `${innerHeight - Math.max(8, top) - 12}px`
    }
    const toggled = (event: Event) => {
      // Reset before the popover opens. The queued `toggle` event can arrive after
      // a user has already typed, clearing their first query during a quick reopen.
      const visible = (event as ToggleEvent).newState === 'open'
      setOpen(visible)
      setQuery('')
      cancelAnimationFrame(frame)
      if (visible) {
        position()
        frame = requestAnimationFrame(() => {
          search.current?.focus({ preventScroll: true })
          el.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
        })
      }
    }
    const moved = () => { if (el.matches(':popover-open')) position() }
    el.addEventListener('beforetoggle', toggled)
    window.addEventListener('resize', moved)
    window.addEventListener('scroll', moved, true)
    return () => {
      el.removeEventListener('beforetoggle', toggled)
      window.removeEventListener('resize', moved)
      window.removeEventListener('scroll', moved, true)
      cancelAnimationFrame(frame)
    }
  }, [])

  const choose = (id: string) => {
    onSelect(id)
    popup.current?.hidePopover()
    trigger.current?.focus({ preventScroll: true })
  }

  return <div className="mb-site">
    <span className="dot" style={{ background: GROUP_COLOR[site.group] }} />
    <button ref={trigger} className="mb-select" aria-label="Site" aria-describedby="current-site-name" aria-haspopup="dialog" aria-expanded={open} aria-controls="site-picker" popoverTarget="site-picker" data-site-id={site.id} title={site.name}>
      <span className="mb-select-text" id="current-site-name">{site.name}</span>
    </button>
    <div ref={popup} id="site-picker" className="site-picker" popover="auto" role="dialog" aria-label="Choose a site">
      <div className="site-picker-head">
        <input ref={search} className="input" type="search" aria-label="Search sites" placeholder={`Search ${sites.length} sites`} value={query} onChange={e => setQuery(e.target.value)} />
        <span className="faint" title="Candidate sites are compared, searched and offered as delay replacements. Use the circles to add or remove them.">{pinned.length} candidates</span>
        <button className="icon-btn sm" aria-label="Close site picker" onClick={() => popup.current?.hidePopover()}>×</button>
      </div>
      <div className="site-picker-results">
        {GROUPS.map(group => {
          const rows = matches.filter(s => s.group === group)
          return rows.length ? <section key={group}>
            <div className="sitegroup">{group}</div>
            {rows.map(s => <div className="site-picker-row" key={s.id}>
              <button className="site-picker-choice" data-site-id={s.id} aria-current={s.id === site.id ? 'true' : undefined} onClick={() => choose(s.id)}>
                <span className="dot" style={{ background: GROUP_COLOR[s.group] }} />
                <span>{s.name}</span><span className="site-picker-lat">{fmtLat(s.lat)}</span>
              </button>
              <button className="site-picker-pin" aria-label={pinned.includes(s.id) ? `Remove ${s.name} from comparison` : `Compare ${s.name}`} aria-pressed={pinned.includes(s.id)} title={pinned.includes(s.id) ? 'Remove from candidates' : 'Add to candidates'} onClick={() => onPin(s.id)}>{pinned.includes(s.id) ? '●' : '○'}</button>
              {s.custom && <button className="site-picker-pin" aria-label={`Remove ${s.name}`} title="Remove this site" onClick={() => onRemove(s.id)}>×</button>}
            </div>)}
          </section> : null
        })}
        {!matches.length && <p className="site-picker-empty">No matching sites.</p>}
      </div>
    </div>
  </div>
}
