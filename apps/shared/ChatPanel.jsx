import { useEffect, useRef, useState } from 'preact/hooks'
import Markdown from './Markdown.jsx'
import './chat.css'

const T = {
  es: {
    call: 'Llamar', callTitle: 'Hablar por voz con el asistente',
    close: 'Cerrar chat', send: 'Enviar', end: 'Finalizar', typing: 'Escribiendo…', accept: 'Acepto', powered: 'Powered by Zentekia',
    sources: 'Fuentes', useful: 'Útil', notUseful: 'No útil', offline: 'Fuera de horario', online: 'En línea',
    endTitle: '¿Finalizar la conversación?', endText: 'Se cerrará este chat. Si después necesitas algo más, puedes iniciar uno nuevo.',
    endYes: 'Sí, finalizar', endNo: 'Seguir platicando', endedTag: 'Conversación cerrada', ended: 'Conversación finalizada',
    endedText: 'Gracias por escribirnos.', rate: '¿Cómo te atendimos?', thanks: '¡Gracias por tu calificación!', newc: 'Iniciar nueva conversación',
    you: 'Tú', star: (n) => `${n} de 5 estrellas`,
  },
  en: {
    call: 'Call', callTitle: 'Talk to the assistant by voice',
    close: 'Close chat', send: 'Send', end: 'End chat', typing: 'Typing…', accept: 'I agree', powered: 'Powered by Zentekia',
    sources: 'Sources', useful: 'Helpful', notUseful: 'Not helpful', offline: 'Offline', online: 'Online',
    endTitle: 'End this conversation?', endText: 'This chat will be closed. You can start a new one anytime.',
    endYes: 'Yes, end it', endNo: 'Keep chatting', endedTag: 'Conversation closed', ended: 'Conversation ended',
    endedText: 'Thanks for reaching out.', rate: 'How did we do?', thanks: 'Thanks for your rating!', newc: 'Start a new conversation',
    you: 'You', star: (n) => `${n} of 5 stars`,
  },
  pt: {
    call: 'Ligar', callTitle: 'Falar por voz com o assistente',
    close: 'Fechar chat', send: 'Enviar', end: 'Encerrar', typing: 'Digitando…', accept: 'Aceito', powered: 'Powered by Zentekia',
    sources: 'Fontes', useful: 'Útil', notUseful: 'Não útil', offline: 'Fora do horário', online: 'Online',
    endTitle: 'Encerrar a conversa?', endText: 'Este chat será fechado. Você pode iniciar outro quando quiser.',
    endYes: 'Sim, encerrar', endNo: 'Continuar', endedTag: 'Conversa encerrada', ended: 'Conversa encerrada',
    endedText: 'Obrigado pelo contato.', rate: 'Como foi o atendimento?', thanks: 'Obrigado pela avaliação!', newc: 'Iniciar nova conversa',
    you: 'Você', star: (n) => `${n} de 5 estrelas`,
  },
}

export function themeVars(t) {
  const v = { '--zw-primary': t.primary, '--zw-secondary': t.secondary, '--zw-user': t.user_bubble, '--zw-user-text': t.user_text }
  if (t.appearance === 'claro') {
    Object.assign(v, { '--zw-bg': t.background, '--zw-text': t.text, '--zw-agent': t.agent_bubble, '--zw-agent-text': t.agent_text })
  }
  return v
}

const Star = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z" /></svg>
)

/** Panel del chat: lo usa el widget real (iframe) y la vista previa del portal */
export default function ChatPanel({
  theme,
  language = 'es',
  logoUrl,
  messages,
  typing,
  suggested = [],
  onSend,
  onClose,
  onEnd,
  onNew,
  onRate,
  ended,
  rating,
  onFeedback,
  privacy,
  offline,
  notice,
  disabled,
  preview,
  onCall,
}) {
  const t = T[language] || T.es
  const [text, setText] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [hover, setHover] = useState(0)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const title = theme.header_title || theme.assistant_name
  const initial = (theme.assistant_name || '?').trim().charAt(0).toUpperCase()
  const needsPrivacy = privacy && privacy.required && !privacy.accepted
  const hasUser = messages.some((m) => m.role === 'user')

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, typing, ended, rating])

  const send = (e) => {
    e?.preventDefault()
    const v = text.trim()
    if (!v || disabled || needsPrivacy || ended) return
    setText('')
    onSend?.(v)
    inputRef.current?.focus()
  }
  const showSuggested = suggested.length > 0 && !hasUser && !ended

  return (
    <section class={'zw' + (theme.appearance === 'claro' ? ' zw-light' : '') + (preview ? ' zw-preview' : '')} style={themeVars(theme)} aria-label={title}>
      <header class={'zw-head' + (offline ? ' off' : '')}>
        <div class="zw-avatar" aria-hidden="true">
          <span>{logoUrl ? <img src={logoUrl} alt="" /> : initial}</span>
        </div>
        <div class="zw-titles">
          <div class="zw-title">{title}</div>
          <div class="zw-subtitle zw-mono">{offline ? t.offline : theme.header_subtitle || t.online}</div>
        </div>
        {onCall && (
          <button class="zw-call" type="button" title={t.callTitle} aria-label={t.callTitle} onClick={onCall}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" /></svg>
            <span>{t.call}</span>
          </button>
        )}
        {onClose && (
          <button class="zw-icon" type="button" title={t.close} aria-label={t.close} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6.7 5.3 12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 1.4-1.4z" /></svg>
          </button>
        )}
      </header>

      <div class="zw-list" ref={listRef} role="log" aria-live="polite" aria-relevant="additions">
        {messages.map((m, i) => (
          <div key={m.id} class={`zw-msg zw-${m.role}${m.error ? ' zw-err' : ''}`}>
            {m.role === 'assistant' && (i === 0 || messages[i - 1].role !== 'assistant') && <div class="zw-who zw-mono">{theme.assistant_name}</div>}
            <div class="zw-bubble">{m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}</div>
            {m.role === 'assistant' && m.sources?.length > 0 && (
              <div class="zw-sources">
                {t.sources}: {m.sources.map((s, k) => (s.url ? <a key={k} href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.name}</a> : <span key={k}>{s.name}</span>)).reduce((a, b) => [a, ' · ', b])}
              </div>
            )}
            {m.role === 'assistant' && onFeedback && m.final && !ended && (
              <div class="zw-fb">
                <button type="button" aria-pressed={m.feedback === 1} aria-label={t.useful} class={m.feedback === 1 ? 'on' : ''} onClick={() => onFeedback(m.id, m.feedback === 1 ? null : 1)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 21h4V9H2v12zm20-11a2 2 0 0 0-2-2h-6.3l1-4.6v-.3a1.5 1.5 0 0 0-.5-1L13.2 1 6.6 7.6A2 2 0 0 0 6 9v10a2 2 0 0 0 2 2h9a2 2 0 0 0 1.8-1.2l3-7.1c.1-.2.2-.5.2-.7v-2z" /></svg>
                </button>
                <button type="button" aria-pressed={m.feedback === -1} aria-label={t.notUseful} class={m.feedback === -1 ? 'on' : ''} onClick={() => onFeedback(m.id, m.feedback === -1 ? null : -1)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M22 3h-4v12h4V3zM2 14a2 2 0 0 0 2 2h6.3l-1 4.6v.3c0 .4.2.8.5 1l1.1 1.1 6.6-6.6c.3-.4.5-.9.5-1.4V5a2 2 0 0 0-2-2H7a2 2 0 0 0-1.8 1.2l-3 7.1c-.1.2-.2.5-.2.7v2z" /></svg>
                </button>
              </div>
            )}
          </div>
        ))}
        {typing && (
          <div class="zw-msg zw-assistant">
            <div class="zw-bubble zw-typing" aria-label={t.typing}><i /><i /><i /></div>
          </div>
        )}
        {showSuggested && (
          <div class="zw-suggest">
            {suggested.map((s) => (
              <button key={s} type="button" onClick={() => !disabled && !needsPrivacy && onSend?.(s)}>{s}</button>
            ))}
          </div>
        )}
        {notice && !ended && <div class="zw-notice">{notice}</div>}
        {ended && (
          <div class="zw-ended" role="status">
            <div class="zw-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9.5 16.6 4.9 12l-1.4 1.4 6 6L21 7.9l-1.4-1.4z" /></svg>
            </div>
            <div class="zw-mono">{t.endedTag}</div>
            <h3>{t.ended}</h3>
            <p>{t.endedText}</p>
            {onRate && !rating && (
              <>
                <p style="margin-top:12px;color:var(--zw-text)">{t.rate}</p>
                <div class="zw-stars" role="radiogroup" aria-label={t.rate} onMouseLeave={() => setHover(0)}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked="false" aria-label={t.star(n)} class={n <= hover ? 'on' : ''} onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onClick={() => onRate(n)}>
                      <Star />
                    </button>
                  ))}
                </div>
              </>
            )}
            {rating ? (
              <>
                <div class="zw-stars" aria-label={t.star(rating)}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span key={n} style={`color:${n <= rating ? '#fbbf24' : 'var(--zw-line-2)'}`}><Star /></span>
                  ))}
                </div>
                <p class="zw-thanks" style="margin-top:0 !important">{t.thanks}</p>
              </>
            ) : null}
            {onNew && (
              <button type="button" class="zw-btn zw-btn-primary" onClick={onNew}>{t.newc}</button>
            )}
          </div>
        )}
      </div>

      {!ended &&
        (needsPrivacy ? (
          <div class="zw-privacy">
            <Markdown text={privacy.text} />
            <button type="button" class="zw-btn zw-btn-primary" onClick={privacy.onAccept}>{t.accept}</button>
          </div>
        ) : (
          <div class="zw-composer">
            {privacy?.text && !privacy.required && <div class="zw-privacy-note"><Markdown text={privacy.text} /></div>}
            <form class="zw-form" onSubmit={send}>
              <label class="zw-sr" for="zw-input">{theme.placeholder}</label>
              <textarea
                id="zw-input"
                ref={inputRef}
                rows="1"
                maxLength={2000}
                placeholder={theme.placeholder}
                value={text}
                disabled={disabled}
                onInput={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) send(e)
                }}
              />
              {onEnd && hasUser && (
                <button class="zw-end" type="button" onClick={() => setConfirm(true)} title={t.endTitle} aria-label={t.endTitle}>
                  <i aria-hidden="true" />
                  <span class="zw-mono">{t.end}</span>
                </button>
              )}
              <button class="zw-send" type="submit" disabled={disabled || !text.trim()} aria-label={t.send}>
                <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" /></svg>
              </button>
            </form>
          </div>
        ))}
      {theme.show_powered_by && (
        <div class="zw-powered zw-mono" style={ended ? 'padding-bottom:10px' : ''}>
          <i aria-hidden="true" />
          {t.powered}
        </div>
      )}

      {confirm && (
        <div class="zw-sheet-bg" onClick={(e) => e.target === e.currentTarget && setConfirm(false)}>
          <div class="zw-sheet" role="alertdialog" aria-modal="true" aria-labelledby="zw-end-title">
            <div class="zw-mono">{t.end}</div>
            <h3 id="zw-end-title">{t.endTitle}</h3>
            <p>{t.endText}</p>
            <div class="zw-row">
              <button type="button" class="zw-btn zw-btn-ghost" onClick={() => setConfirm(false)} autoFocus>{t.endNo}</button>
              <button type="button" class="zw-btn zw-btn-danger" onClick={() => { setConfirm(false); onEnd() }}>{t.endYes}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
