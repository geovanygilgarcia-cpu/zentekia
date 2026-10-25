import { createPortal } from 'preact/compat'
import { useEffect, useRef, useState } from 'preact/hooks'
import './usermenu.css'
import { uiZoom } from './Theme.jsx'

const LogoutIcon = ({ size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 17l5-5-5-5M21 12H9" />
  </svg>
)
const Chevron = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>
)

/**
 * Menú de cuenta con botón de cerrar sesión. Lo usan el panel admin y el portal del cliente.
 * variant: 'chip' (barra superior), 'card' (pie del menú lateral), 'icon' (solo avatar, para celular)
 */
export default function UserMenu({ user, roleLabel, onLogout, onAccount, variant = 'chip', className = '' }) {
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [pos, setPos] = useState(null)
  const btn = useRef(null)
  const menu = useRef(null)
  const name = user.name || user.email.split('@')[0]
  const initial = name.trim().charAt(0).toUpperCase()

  const place = () => {
    const b = btn.current?.getBoundingClientRect()
    if (!b) return
    // Con letra grande la página lleva zoom: se pasa todo a las mismas unidades
    const z = uiZoom()
    const r = { left: b.left / z, right: b.right / z, top: b.top / z, bottom: b.bottom / z }
    const vw = window.innerWidth / z
    const vh = window.innerHeight / z
    const w = Math.min(280, vw - 24)
    const left = Math.max(12, Math.min(vw - w - 12, variant === 'card' ? r.left : r.right - w))
    // En el pie del menú lateral se abre hacia arriba; en la barra superior, hacia abajo
    setPos(variant === 'card' ? { left, width: w, bottom: vh - r.top + 8 } : { left, width: w, top: r.bottom + 8 })
  }

  useEffect(() => {
    if (!open) return
    place()
    const onDoc = (e) => {
      if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btn.current?.focus()
      }
    }
    const onResize = () => place()
    document.addEventListener('pointerdown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    setTimeout(() => menu.current?.querySelector('.um-item, .um-out')?.focus(), 0)
    return () => {
      document.removeEventListener('pointerdown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open])

  const logout = async () => {
    if (leaving) return
    setLeaving(true)
    try {
      await onLogout()
    } finally {
      setLeaving(false)
    }
  }

  return (
    <div class={`um um-${variant} ${className}`}>
      <button ref={btn} type="button" class={'um-trigger' + (open ? ' open' : '')} aria-haspopup="menu" aria-expanded={open} aria-label={`Cuenta de ${user.email}`} onClick={() => setOpen(!open)}>
        <span class="um-av" aria-hidden="true">{initial}</span>
        {variant !== 'icon' && (
          <span class="um-id">
            <span class="um-name">{name}</span>
            <span class="um-mail">{user.email}</span>
          </span>
        )}
        {variant !== 'icon' && <span class="um-chev"><Chevron /></span>}
      </button>
      {variant === 'card' && (
        <button type="button" class="um-quick" onClick={logout} disabled={leaving} title="Cerrar sesión" aria-label="Cerrar sesión">
          <LogoutIcon />
        </button>
      )}
      {open && pos && createPortal(
        <div ref={menu} class="um-menu" role="menu" style={{ left: pos.left + 'px', width: pos.width + 'px', top: pos.top != null ? pos.top + 'px' : 'auto', bottom: pos.bottom != null ? pos.bottom + 'px' : 'auto' }}>
          <div class="um-head">
            <span class="um-av um-av-lg" aria-hidden="true">{initial}</span>
            <div class="um-id">
              <span class="um-name">{name}</span>
              <span class="um-mail">{user.email}</span>
              {roleLabel && <span class="um-role">{roleLabel}</span>}
            </div>
          </div>
          {onAccount && (
            <button type="button" role="menuitem" class="um-item" onClick={() => { setOpen(false); onAccount() }}>
              <span class="um-item-ic"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6" /></svg></span>
              <span class="grow">Mi cuenta</span>
            </button>
          )}
          <button type="button" role="menuitem" class="um-out" onClick={logout} disabled={leaving}>
            <span class="um-out-ic"><LogoutIcon size={17} /></span>
            <span class="grow">{leaving ? 'Cerrando sesión…' : 'Cerrar sesión'}</span>
            <kbd>⏎</kbd>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
