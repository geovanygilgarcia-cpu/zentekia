/* Lectura y limpieza del streaming del modelo */

/*
  Cada modelo de Workers AI manda el streaming con una forma un poco distinta
  ({"response":"..."} o {"choices":[{"delta":{"content":"..."}}]}, a veces con
  "razonamiento" aparte). Aquí se traduce todo a un solo formato para el widget:
      data: {"response":"texto"}
  y se quita cualquier bloque <think>…</think> que el modelo llegue a mandar.
*/
export function normalizarStream(entrada, onFin) {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  let buf = ''
  let dentroDeThink = false
  let pendiente = '' // texto retenido por si una etiqueta <think> llega partida

  const emitir = (controller, texto) => {
    if (texto) controller.enqueue(enc.encode(`data: ${JSON.stringify({ response: texto })}\n\n`))
  }

  // Filtra <think>…</think> aunque llegue cortado entre trozos
  const filtrar = (texto) => {
    let s = pendiente + texto
    pendiente = ''
    let salida = ''
    while (s) {
      if (dentroDeThink) {
        const fin = s.indexOf('</think>')
        if (fin === -1) {
          pendiente = s.slice(-8)
          return salida
        }
        s = s.slice(fin + 8)
        dentroDeThink = false
      } else {
        const ini = s.indexOf('<think>')
        if (ini === -1) {
          // retener un posible "<thi" al final
          const corte = s.lastIndexOf('<')
          if (corte !== -1 && '<think>'.startsWith(s.slice(corte))) {
            pendiente = s.slice(corte)
            return salida + s.slice(0, corte)
          }
          return salida + s
        }
        salida += s.slice(0, ini)
        s = s.slice(ini + 7)
        dentroDeThink = true
      }
    }
    return salida
  }

  let inicio = true
  let completo = '' // respuesta entera, para guardarla en el historial al terminar
  return new ReadableStream({
    async start(controller) {
      const reader = entrada.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += typeof value === 'string' ? value : dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const linea = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (!linea.startsWith('data:')) continue
            const data = linea.slice(5).trim()
            if (data === '[DONE]') continue
            let j
            try {
              j = JSON.parse(data)
            } catch {
              continue
            }
            let texto = j.response ?? j.choices?.[0]?.delta?.content ?? ''
            if (typeof texto === 'number') {
              // Workers AI manda los números como número JSON (30 en vez de "30"): se toman tal cual del texto original
              const m = data.match(/"(?:response|content)"\s*:\s*(-?\d[\d.eE+-]*)/)
              texto = m ? m[1] : String(texto)
            }
            if (typeof texto !== 'string') texto = ''
            texto = filtrar(texto)
            if (inicio) {
              texto = texto.replace(/^\s+/, '') // sin saltos de línea al principio
              if (texto) inicio = false
            }
            completo += texto
            emitir(controller, texto)
          }
        }
        if (pendiente && !dentroDeThink) {
          completo += pendiente
          emitir(controller, pendiente)
        }
      } catch (e) {
        console.error('Error leyendo el stream del modelo:', e)
      } finally {
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
        try {
          onFin?.(completo)
        } catch (e) {
          console.error('Error al terminar la respuesta:', e)
        }
      }
    },
  })
}
